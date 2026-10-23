import AsyncStorage from "@react-native-async-storage/async-storage";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import Pitch from "~/app/pitch";

// This file lives in `__tests__/` rather than next to the screen in `app/`, and
// it has to. expo-router treats every file under `app/` as a route, so a
// colocated `pitch.test.tsx` is bundled into the app itself — it pulled
// @testing-library/react-native into the client bundle and crashed the running
// app with `Missing dev dependency "react-test-renderer"`. Jest's testMatch is
// rootDir-wide, so it is collected here just the same.
//
// Component tests for anything under `components/` or `hooks/` stay colocated;
// only screens have this constraint.
import { useBarneyChat } from "~/hooks/useBarneyChat";
import { useGuardedRoute } from "~/hooks/useGuardedRoute";
import { usePitchSession } from "~/hooks/usePitchSession";
import { ServerReportedError } from "~/lib/api";
import { submitDecision } from "~/lib/decision";

// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above the imports, so the mock cannot be pulled in with one.
jest.mock("react-native-reanimated", () => require("react-native-reanimated/mock"));
jest.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("~/components/AppNav", () => () => null);
// expo-router pulls @react-navigation/native, which ships ESM that Jest cannot
// require. The screen only uses the router to leave, so a spy is both enough
// and what the leaving assertions below need.
const mockReplace = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: mockReplace }) }));
// The real thing needs a native module. The package's own in-memory mock is
// enough here and, unlike a stub returning null, it actually stores — which is
// the point: these tests have to be able to unmount the screen and see what a
// remount reads back.
jest.mock("@react-native-async-storage/async-storage", () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- see the reanimated mock above.
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);
jest.mock("~/hooks/useGuardedRoute", () => ({ useGuardedRoute: jest.fn() }));
jest.mock("~/hooks/usePitchSession", () => ({ usePitchSession: jest.fn() }));
jest.mock("~/hooks/useBarneyChat", () => ({ useBarneyChat: jest.fn() }));
jest.mock("~/lib/decision", () => ({ submitDecision: jest.fn() }));

const mockGuard = useGuardedRoute as jest.MockedFunction<typeof useGuardedRoute>;
const mockSession = usePitchSession as jest.MockedFunction<typeof usePitchSession>;
const mockChat = useBarneyChat as jest.MockedFunction<typeof useBarneyChat>;
const mockDecide = submitDecision as jest.MockedFunction<typeof submitDecision>;

const SESSION = "0f1e2d3c-4b5a-4697-8899-aabbccddeeff";

function setup({
  send = jest.fn().mockResolvedValue(true),
  busy = false,
  sessionId = SESSION,
}: { send?: jest.Mock; busy?: boolean; sessionId?: string | null } = {}) {
  // matchId now comes from the guard's own state read rather than a second
  // fetch of its own (#464).
  mockGuard.mockReturnValue({
    userId: "u-1",
    ready: true,
    state: { matchId: "m-1" } as unknown as NonNullable<
      ReturnType<typeof useGuardedRoute>["state"]
    >,
  });
  mockSession.mockReturnValue({
    partnerName: "Suzy",
    education: "Design, Third year",
    matchPhotoUrl: null,
    loaded: true,
  });
  mockChat.mockReturnValue({
    sessionId,
    messages: [],
    loading: false,
    busy,
    done: false,
    initFailed: false,
    section: null,
    progress: undefined,
    input: undefined,
    send,
    goBack: jest.fn(),
    retryInit: jest.fn(),
  } as unknown as ReturnType<typeof useBarneyChat>);
  return { send, ...render(<Pitch />) };
}

/**
 * Renders the screen and lets the stored question count land.
 *
 * The extra flush is not ceremony: the screen reads the count for this
 * conversation asynchronously on mount, and asserting before it resolves tests
 * a frame the user never interacts with — the composer is deliberately shut in
 * it. It also keeps that update inside `act`, which is what silences React's
 * warning about it.
 */
async function mount(opts?: Parameters<typeof setup>[0]) {
  const utils = setup(opts);
  await act(async () => {});
  return utils;
}

const composer = () => screen.getByLabelText("Message input");

// Presses Send rather than firing submitEditing: the composer is multiline, so
// the return key inserts a line break there and Send is the real affordance —
// the same route BarneyChat's own suite drives.
async function ask(text: string) {
  fireEvent.changeText(composer(), text);
  await act(async () => {
    fireEvent.press(screen.getByLabelText("Send"));
  });
}

beforeEach(async () => {
  jest.clearAllMocks();
  // The AsyncStorage mock is module state and outlives a test, so the stored
  // question count has to be cleared or one test's spent allowance closes the
  // next one's composer.
  await AsyncStorage.clear();
  mockDecide.mockResolvedValue({ waiting: true });
});

describe("the pitch screen", () => {
  it("opens on the reveal card, not the chat", async () => {
    await mount();
    expect(screen.getByTestId("intro-partner-name")).toHaveTextContent("Suzy");
    expect(screen.queryByTestId("questions-left")).toBeNull();
  });

  it("enters the chat from 'Send a wish'", async () => {
    await mount();
    fireEvent.press(screen.getByTestId("send-a-wish"));
    expect(screen.getByTestId("questions-left")).toHaveTextContent("3 questions left");
  });
});

describe("the Genie Mechanic counter", () => {
  async function enterChat(opts?: Parameters<typeof setup>[0]) {
    const utils = await mount(opts);
    fireEvent.press(screen.getByTestId("send-a-wish"));
    return utils;
  }

  it("counts down one question per answered turn", async () => {
    const { send } = await enterChat();

    await ask("What are they like?");
    await waitFor(() =>
      expect(screen.getByTestId("questions-left")).toHaveTextContent("2 questions left")
    );

    await ask("What do they do?");
    await waitFor(() =>
      expect(screen.getByTestId("questions-left")).toHaveTextContent("1 question left")
    );

    expect(send).toHaveBeenCalledTimes(2);
  });

  // The acceptance criterion, and the reason the mechanic is enforced here at
  // all: PITCH_PROMPT never tells Barney to stop counting (ADR-0013).
  it("makes a fourth question impossible", async () => {
    const { send } = await enterChat();

    await ask("One");
    await ask("Two");
    await ask("Three");

    await waitFor(() =>
      expect(screen.getByTestId("questions-left")).toHaveTextContent("No questions left")
    );
    expect(send).toHaveBeenCalledTimes(3);

    // The composer is disabled rather than unmounted, so the check that matters
    // is behavioural: a 4th question driven exactly like the three that worked
    // must not reach Barney.
    expect(composer().props.editable).toBe(false);
    await ask("Four");
    expect(send).toHaveBeenCalledTimes(3);
  });

  // useBarneyChat leaves the user's message in the transcript when a turn
  // fails, so anything counting sent messages would charge for the api being
  // unreachable.
  it("does not spend a question when the turn fails", async () => {
    await enterChat({ send: jest.fn().mockResolvedValue(false) });

    await ask("What are they like?");

    await waitFor(() =>
      expect(screen.getByTestId("questions-left")).toHaveTextContent("3 questions left")
    );
  });

  it("refuses to send while a turn is still in flight", async () => {
    const { send } = await enterChat({ busy: true });

    await ask("What are they like?");

    expect(send).not.toHaveBeenCalled();
    expect(screen.getByTestId("questions-left")).toHaveTextContent("3 questions left");
  });
});

// useBarneyChat resumes a pitch from storage with its transcript intact, so a
// count that lived only in component state came back as zero against a chat
// that had already used all three questions: the composer reopened and the
// fourth question the mechanic exists to prevent went through. Nothing
// downstream would have stopped it — PITCH_PROMPT never tells Barney there is a
// limit (ADR-0013).
describe("the counter across a reload", () => {
  async function enterChat(opts?: Parameters<typeof setup>[0]) {
    const utils = await mount(opts);
    fireEvent.press(screen.getByTestId("send-a-wish"));
    return utils;
  }

  it("remembers a spent allowance when the same conversation resumes", async () => {
    await enterChat();
    await ask("One");
    await ask("Two");
    await ask("Three");
    await waitFor(() =>
      expect(screen.getByTestId("questions-left")).toHaveTextContent("No questions left")
    );

    screen.unmount();
    const { send } = await enterChat();

    await waitFor(() =>
      expect(screen.getByTestId("questions-left")).toHaveTextContent("No questions left")
    );
    expect(composer().props.editable).toBe(false);
    await ask("Four");
    expect(send).not.toHaveBeenCalled();
  });

  it("remembers a partly spent allowance", async () => {
    await enterChat();
    await ask("One");

    screen.unmount();
    await enterChat();

    await waitFor(() =>
      expect(screen.getByTestId("questions-left")).toHaveTextContent("2 questions left")
    );
  });

  // The other half of keying on the conversation: a session the api has
  // forgotten is replaced by a fresh one, and that user is starting the pitch
  // over against an empty transcript. Carrying the old count into it would
  // leave them with a chat they cannot use.
  it("does not carry a count into a new conversation", async () => {
    await enterChat();
    await ask("One");
    await ask("Two");

    screen.unmount();
    await enterChat({ sessionId: "9a8b7c6d-5e4f-4a3b-8c1d-2e3f4a5b6c7d" });

    await waitFor(() =>
      expect(screen.getByTestId("questions-left")).toHaveTextContent("3 questions left")
    );
    expect(composer().props.editable).toBe(true);
  });

  // A failed turn must survive the reload as *not spent*, which is the whole
  // reason the count is stored rather than recomputed from the transcript:
  // useBarneyChat leaves the user's message there either way.
  it("does not spend a question that failed, even across a reload", async () => {
    await enterChat({ send: jest.fn().mockResolvedValue(false) });
    await ask("One");

    screen.unmount();
    await enterChat();

    await waitFor(() =>
      expect(screen.getByTestId("questions-left")).toHaveTextContent("3 questions left")
    );
  });
});

// #464. The pitch's two committing buttons, and the one asymmetry that matters:
// the reveal degrades when it fails, a decision must not.
describe("the Yeah/Nah decision", () => {
  // By testID rather than label: the Nah button reads "Neh", matching web's
  // wording, while the domain term stays Yeah/Nah (CONTEXT.md).
  const decisionButton = (choice: "yeah" | "nah") => screen.getByTestId(`decide-${choice}`);

  it("reaches the decision from 'Maybe later', skipping the questions", async () => {
    await mount();
    fireEvent.press(screen.getByTestId("send-a-wish"));
    expect(screen.getByTestId("questions-left")).toBeTruthy();

    screen.unmount();
    await mount();
    fireEvent.press(screen.getByText("Maybe later"));

    expect(screen.queryByTestId("questions-left")).toBeNull();
    expect(decisionButton("yeah")).toBeTruthy();
  });

  // The way out of a spent chat. Without it the user has met the limit and the
  // screen has nothing left they can act on.
  it("offers the decision once the allowance is spent, and not before", async () => {
    const { send } = await mount();
    fireEvent.press(screen.getByTestId("send-a-wish"));

    await ask("One");
    await ask("Two");
    expect(screen.queryByTestId("see-who-it-is")).toBeNull();

    await ask("Three");
    await waitFor(() => expect(screen.getByTestId("see-who-it-is")).toBeTruthy());
    expect(send).toHaveBeenCalledTimes(3);

    fireEvent.press(screen.getByTestId("see-who-it-is"));
    expect(decisionButton("yeah")).toBeTruthy();
  });

  it("sends yeah and holds, rather than navigating", async () => {
    await mount();
    fireEvent.press(screen.getByText("Maybe later"));

    await act(async () => {
      fireEvent.press(decisionButton("yeah"));
    });

    expect(mockDecide).toHaveBeenCalledWith("m-1", "u-1", "yeah");
    // The other side has not answered yet, so there is nowhere to go — the
    // server moves this user on, and the poll is what notices.
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByText("You said yeah.")).toBeTruthy();
  });

  it("sends nah and leaves for the pool", async () => {
    await mount();
    fireEvent.press(screen.getByText("Maybe later"));

    await act(async () => {
      fireEvent.press(decisionButton("nah"));
    });

    expect(mockDecide).toHaveBeenCalledWith("m-1", "u-1", "nah");
    expect(mockReplace).toHaveBeenCalledWith("/waiting");
  });

  // The asymmetry with the reveal, which deliberately degrades instead. A
  // decision the user believes they made and the server never recorded leaves
  // them waiting on a match that is not waiting on them, until the window
  // expires and auto-Nahs it.
  it("surfaces a failed decision instead of pretending it landed", async () => {
    mockDecide.mockRejectedValue(new ServerReportedError("Match not found"));
    await mount();
    fireEvent.press(screen.getByText("Maybe later"));

    await act(async () => {
      fireEvent.press(decisionButton("yeah"));
    });

    // The server's own words, not a generic apology — "Match not found" tells
    // the user what happened.
    expect(screen.getByTestId("decision-error")).toHaveTextContent("Match not found");
    expect(screen.queryByText("You said yeah.")).toBeNull();
    expect(mockReplace).not.toHaveBeenCalled();
    // Still on the decision screen, so the user can try again.
    expect(decisionButton("yeah")).toBeTruthy();
  });

  it("falls back to its own wording for an error the server did not author", async () => {
    mockDecide.mockRejectedValue(new Error("socket hang up"));
    await mount();
    fireEvent.press(screen.getByText("Maybe later"));

    await act(async () => {
      fireEvent.press(decisionButton("yeah"));
    });

    expect(screen.getByTestId("decision-error")).toHaveTextContent(
      "Could not record your decision. Please try again."
    );
  });

  it("does not submit twice while one decision is in flight", async () => {
    await mount();
    fireEvent.press(screen.getByText("Maybe later"));

    await act(async () => {
      fireEvent.press(decisionButton("yeah"));
      fireEvent.press(decisionButton("yeah"));
    });

    expect(mockDecide).toHaveBeenCalledTimes(1);
  });
});
