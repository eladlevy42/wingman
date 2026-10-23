import { render, screen, fireEvent, act, waitFor } from "@testing-library/react-native";
import ChooseTimes from "~/app/choose-times";
import { useGuardedRoute } from "~/hooks/useGuardedRoute";
import { submitAvailability } from "~/lib/schedule";

// Screen tests live here rather than beside the screen: expo-router bundles
// every file under `app/` as a route. See the note in pitch.test.tsx.

// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above the imports.
jest.mock("react-native-reanimated", () => require("react-native-reanimated/mock"));
jest.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
const mockReplace = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock("~/hooks/useGuardedRoute", () => ({ useGuardedRoute: jest.fn() }));
jest.mock("~/lib/schedule", () => ({
  ...jest.requireActual("~/lib/schedule"),
  submitAvailability: jest.fn(),
}));

const mockGuard = useGuardedRoute as jest.MockedFunction<typeof useGuardedRoute>;
const mockSubmit = submitAvailability as jest.MockedFunction<typeof submitAvailability>;

// Fixed and far in the future so the rendered labels never depend on today.
const SLOTS = [
  "2030-06-03T18:00:00.000Z",
  "2030-06-04T18:00:00.000Z",
  "2030-06-05T18:00:00.000Z",
  "2030-06-06T18:00:00.000Z",
  "2030-06-07T18:00:00.000Z",
];

function setup(state: Record<string, unknown>) {
  mockGuard.mockReturnValue({
    userId: "u-1",
    ready: true,
    state: { matchId: "m-1", ...state } as unknown as NonNullable<
      ReturnType<typeof useGuardedRoute>["state"]
    >,
  });
  return render(<ChooseTimes />);
}

const slots = () => screen.queryAllByTestId("time-slot");

beforeEach(() => {
  jest.clearAllMocks();
  mockSubmit.mockResolvedValue({ waiting: true, matchingState: "CHOOSING_TIMES" });
});

describe("the proposer", () => {
  const asProposer = (over: Record<string, unknown> = {}) =>
    setup({ timeRole: "proposer", candidateSlots: SLOTS, proposedSlots: [], ...over });

  it("is offered the whole candidate slate", () => {
    asProposer();
    expect(screen.getByText("When are you free?")).toBeTruthy();
    expect(slots()).toHaveLength(SLOTS.length);
  });

  // ADR-0012: the proposer forwards up to three, and the chooser picks one of
  // those. A fourth would change what the chooser is being asked.
  it("cannot forward more than three times", () => {
    asProposer();
    for (const slot of slots()) fireEvent.press(slot);
    expect(screen.getByText("3 / 3")).toBeTruthy();
  });

  it("de-selects a time that was picked by mistake", () => {
    asProposer();
    fireEvent.press(slots()[0]);
    expect(screen.getByText("1 / 3")).toBeTruthy();
    fireEvent.press(slots()[0]);
    expect(screen.getByText("0 / 3")).toBeTruthy();
  });

  it("cannot send nothing", () => {
    asProposer();
    fireEvent.press(screen.getByTestId("confirm-times"));
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("waits on the chooser once its times are sent", async () => {
    asProposer();
    fireEvent.press(slots()[0]);

    await act(async () => {
      fireEvent.press(screen.getByTestId("confirm-times"));
    });

    expect(mockSubmit).toHaveBeenCalledWith("m-1", "u-1", [SLOTS[0]]);
    // Not a navigation: forwarding times does not make a date, so the proposer
    // stays here and the poll is what moves them on.
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByText("Times sent.")).toBeTruthy();
  });

  // The flip is state the server already knows: a reload mid-wait must not
  // offer the slate again.
  it("waits without re-offering the slate after a reload", () => {
    asProposer({ hasSubmittedAvailability: true });
    expect(screen.getByText("Times sent.")).toBeTruthy();
    expect(slots()).toHaveLength(0);
  });

  it("does not submit twice on a double tap", async () => {
    asProposer();
    fireEvent.press(slots()[0]);

    await act(async () => {
      fireEvent.press(screen.getByTestId("confirm-times"));
      fireEvent.press(screen.getByTestId("confirm-times"));
    });

    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });
});

describe("the chooser", () => {
  const asChooser = (proposed: string[]) =>
    setup({ timeRole: "chooser", candidateSlots: SLOTS, proposedSlots: proposed });

  it("waits while the proposer has not picked yet", () => {
    asChooser([]);
    expect(screen.getByText("Almost there.")).toBeTruthy();
    expect(slots()).toHaveLength(0);
  });

  // Only the three forwarded, never the full slate — picking outside them would
  // be choosing a time the proposer never offered.
  it("is offered only the forwarded times", () => {
    asChooser(SLOTS.slice(0, 3));
    expect(screen.getByText("Pick your date.")).toBeTruthy();
    expect(slots()).toHaveLength(3);
  });

  it("picks exactly one", () => {
    asChooser(SLOTS.slice(0, 3));
    fireEvent.press(slots()[0]);
    fireEvent.press(slots()[1]);
    expect(screen.getByText("1 / 1")).toBeTruthy();
  });

  it("lands on the date once its pick is accepted", async () => {
    mockSubmit.mockResolvedValue({ waiting: false, matchingState: "DATE_ASSIGNED" });
    asChooser(SLOTS.slice(0, 3));
    fireEvent.press(slots()[1]);

    await act(async () => {
      fireEvent.press(screen.getByTestId("confirm-times"));
    });

    expect(mockSubmit).toHaveBeenCalledWith("m-1", "u-1", [SLOTS[1]]);
    expect(mockReplace).toHaveBeenCalledWith("/blind-date");
  });

  // This tap writes the venue and flips both users, so a failure has to be
  // visible and retryable rather than swallowed.
  it("keeps the user on the screen when the pick fails", async () => {
    mockSubmit.mockRejectedValue(new Error("nope"));
    asChooser(SLOTS.slice(0, 3));
    fireEvent.press(slots()[0]);

    await act(async () => {
      fireEvent.press(screen.getByTestId("confirm-times"));
    });

    await waitFor(() =>
      expect(screen.getByTestId("choose-times-error")).toHaveTextContent(
        "Could not save your choice. Please try again."
      )
    );
    expect(mockReplace).not.toHaveBeenCalled();
    expect(slots()).toHaveLength(3);
  });
});
