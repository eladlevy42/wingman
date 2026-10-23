import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { ChatMessage } from "@wingman/shared";
import { useBarneyChat } from "~/hooks/useBarneyChat";
import { apiRequest } from "~/lib/api";
import { loadBarneySession, saveBarneySession } from "~/lib/barneySession";

jest.mock("~/lib/api", () => ({
  ...jest.requireActual("~/lib/api"),
  apiRequest: jest.fn(),
}));
jest.mock("~/lib/barneySession", () => ({
  loadBarneySession: jest.fn(),
  saveBarneySession: jest.fn().mockResolvedValue(undefined),
  clearBarneySession: jest.fn().mockResolvedValue(undefined),
  matchesConversation: jest.fn(() => true),
}));
jest.mock("~/lib/streamBarneyMessage", () => ({ streamBarneyMessage: jest.fn() }));

const mockApiRequest = apiRequest as jest.MockedFunction<typeof apiRequest>;
const mockLoad = loadBarneySession as jest.MockedFunction<typeof loadBarneySession>;

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

// The conversation the bug was reported against: an interview opened in
// English, then two Hebrew replies — a chat half in each language.
const MIXED_TRANSCRIPT: ChatMessage[] = [
  { role: "assistant", content: "Nice, I feel like I know you now. Let's flip it around:" },
  { role: "assistant", content: "First things first: who are you hoping to meet?" },
  { role: "assistant", content: "אנחנו בשאלה הראשונה, אין לאן לחזור אחורה מכאן." },
];

const RESTATED = {
  reply: "קודם כול, את מי את מקווה לפגוש?",
  phaseComplete: false,
  acknowledgement: null,
  question: "קודם כול, את מי את מקווה לפגוש?",
  section: { title: "מה חשוב לך", index: 1, total: 3 },
  progress: { answered: 0, total: 10 },
  input: {
    kind: "choice" as const,
    allowFreeText: true,
    options: [{ label: "גברים", value: "גברים" }],
  },
};

// Resumes the stored conversation rather than opening a new one, so no turn is
// streamed and the transcript on screen is exactly MIXED_TRANSCRIPT.
async function renderResumedChat() {
  mockLoad.mockResolvedValue({
    sessionId: SESSION_ID,
    userId: "u-1",
    mode: "interview_wants",
    savedAt: Date.now(),
    messages: MIXED_TRANSCRIPT,
    section: null,
    progress: { answered: 0, total: 10 },
    input: { kind: "text" },
  });
  const hook = renderHook(() =>
    useBarneyChat({ userId: "u-1", mode: "interview_wants", language: "he" })
  );
  await waitFor(() => expect(hook.result.current.messages).toEqual(MIXED_TRANSCRIPT));
  await waitFor(() => expect(hook.result.current.busy).toBe(false));
  return hook;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("useBarneyChat — changeLanguage", () => {
  it("replaces the whole conversation with the question restated in the new language", async () => {
    mockApiRequest.mockResolvedValue({ turn: RESTATED });
    const { result } = await renderResumedChat();

    await act(() => result.current.changeLanguage("he"));

    expect(mockApiRequest).toHaveBeenCalledWith(
      "/api/barney/language",
      expect.objectContaining({ method: "POST", body: { sessionId: SESSION_ID, language: "he" } })
    );
    expect(result.current.messages).toEqual([{ role: "assistant", content: RESTATED.question }]);
    expect(result.current.section).toEqual(RESTATED.section);
    expect(result.current.input).toEqual(RESTATED.input);
    expect(result.current.busy).toBe(false);
  });

  it("saves the cleared conversation, so a reload does not bring the mixed one back", async () => {
    mockApiRequest.mockResolvedValue({ turn: RESTATED });
    const { result } = await renderResumedChat();

    await act(() => result.current.changeLanguage("he"));

    await waitFor(() =>
      expect(saveBarneySession).toHaveBeenLastCalledWith(
        expect.objectContaining({
          messages: [{ role: "assistant", content: RESTATED.question }],
        })
      )
    );
  });

  it("leaves the conversation alone when there is nothing to restate", async () => {
    mockApiRequest.mockResolvedValue({ turn: null });
    const { result } = await renderResumedChat();

    await act(() => result.current.changeLanguage("he"));

    expect(result.current.messages).toEqual(MIXED_TRANSCRIPT);
    expect(result.current.busy).toBe(false);
  });

  it("leaves the conversation alone and unlocks the composer when the call fails", async () => {
    mockApiRequest.mockRejectedValue(new Error("offline"));
    const { result } = await renderResumedChat();

    await act(() => result.current.changeLanguage("he"));

    expect(result.current.messages).toEqual(MIXED_TRANSCRIPT);
    expect(result.current.busy).toBe(false);
  });
});
