import { act, render, screen, waitFor } from "@testing-library/react-native";
import Debrief from "~/app/debrief";

// Lives in `__tests__/` for the same reason pitch.test.tsx does: expo-router
// treats every file under `app/` as a route, so a colocated screen test would
// be bundled into the running app.
import { useBarneyChat } from "~/hooks/useBarneyChat";
import { apiRequest } from "~/lib/api";
import { loadUser } from "~/lib/session";

jest.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("~/components/BarneyChat", () => () => null);
jest.mock("~/hooks/useBarneyChat", () => ({ useBarneyChat: jest.fn() }));
jest.mock("~/lib/api", () => {
  // The screen's 404 branch does `instanceof ApiError`, so the mock must hand
  // back a class. No TS parameter properties here — the desugared assignment
  // trips jest's out-of-scope-variable check inside a hoisted factory.
  class ApiError extends Error {
    status: number;
    constructor(status: number) {
      super(`api ${status}`);
      this.status = status;
    }
  }
  return { apiRequest: jest.fn(), ApiError };
});
jest.mock("~/lib/session", () => ({ loadUser: jest.fn(), clearUser: jest.fn() }));
const mockRouterReplace = jest.fn();
jest.mock("expo-router", () => {
  const mockRouter = { replace: (route: unknown) => mockRouterReplace(route) };
  return { useRouter: () => mockRouter };
});

const mockChat = useBarneyChat as jest.MockedFunction<typeof useBarneyChat>;
const mockApiRequest = apiRequest as jest.MockedFunction<typeof apiRequest>;
const mockLoadUser = loadUser as jest.MockedFunction<typeof loadUser>;

const USER = { id: "u-1", name: "Sam" };

// A signed-in user whose date has passed — the one state the screen admits.
const DATE_PASSED_STATE = {
  universityVerified: true,
  hasProfile: true,
  hasPhoto: true,
  matchingState: "DATE_ASSIGNED",
  followUpState: "DATE_PASSED",
  matchId: "m-1",
};

function chatState(overrides: Partial<ReturnType<typeof useBarneyChat>> = {}) {
  return {
    sessionId: "s-1",
    messages: [],
    loading: false,
    busy: false,
    done: false,
    initFailed: false,
    section: null,
    progress: undefined,
    input: undefined,
    send: jest.fn(),
    goBack: jest.fn(),
    retryInit: jest.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useBarneyChat>;
}

async function mount() {
  const utils = render(<Debrief />);
  // Let the guard's user load + state fetch land.
  await act(async () => {});
  return utils;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApiRequest.mockReset();
  mockChat.mockReturnValue(chatState());
  mockLoadUser.mockResolvedValue(USER as never);
  mockApiRequest.mockResolvedValue(DATE_PASSED_STATE as never);
});

describe("the debrief gate", () => {
  it("admits a DATE_PASSED user and opens the debrief session for their match", async () => {
    await mount();

    expect(screen.getByTestId("debrief-heading")).toHaveTextContent("How did your date go?");
    // The chat hook got the debrief session's three essentials.
    expect(mockChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: "u-1", mode: "debrief", matchId: "m-1" })
    );
    expect(mockRouterReplace).not.toHaveBeenCalled();
  });

  // A stale nudge tap: the date passed, the user debriefed, markDebriefed put
  // them back in the pool — the tap must land them where they now belong, not
  // in a debrief the api would refuse to open.
  it("bounces a user who already debriefed to where their state says they belong", async () => {
    mockApiRequest.mockResolvedValue({
      ...DATE_PASSED_STATE,
      matchingState: "WAITING",
      followUpState: "DEBRIEFED",
    } as never);

    await mount();

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith("/waiting"));
  });

  it("bounces a user whose date has not happened yet", async () => {
    mockApiRequest.mockResolvedValue({
      ...DATE_PASSED_STATE,
      followUpState: "AWAITING_DATE",
    } as never);

    await mount();

    // An awaiting date belongs on the date card (/blind-date) — the point here
    // is only that the debrief did not open.
    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalled());
    expect(mockChat).toHaveBeenLastCalledWith(expect.objectContaining({ userId: null }));
  });

  it("sends a signed-out tap to login", async () => {
    mockLoadUser.mockResolvedValue(null as never);

    await mount();

    await waitFor(() => expect(mockRouterReplace).toHaveBeenCalledWith("/login"));
  });

  it("offers a retry when the state lookup fails", async () => {
    mockApiRequest.mockRejectedValue(new Error("offline"));

    await mount();

    expect(screen.getByText("Can't reach Wingman")).toBeTruthy();
  });
});

describe("finishing the debrief", () => {
  it("hands off to the waiting screen after the completion bubble", async () => {
    jest.useFakeTimers();
    try {
      render(<Debrief />);
      // Flush the guard with fake timers active — run pending microtasks.
      await act(async () => {
        await Promise.resolve();
      });

      // The screen's completion callback, exactly as the hook would fire it.
      const { onPhaseComplete } = mockChat.mock.calls.at(-1)![0];
      act(() => {
        onPhaseComplete?.();
      });

      expect(mockRouterReplace).not.toHaveBeenCalled();
      act(() => {
        jest.advanceTimersByTime(1500);
      });
      expect(mockRouterReplace).toHaveBeenCalledWith("/waiting");
    } finally {
      jest.useRealTimers();
    }
  });
});
