import { render, screen, fireEvent, act, waitFor } from "@testing-library/react-native";
import BlindDate from "~/app/blind-date";
import { useGuardedRoute } from "~/hooks/useGuardedRoute";
import { ServerReportedError } from "~/lib/api";
import { loadBlindDate } from "~/lib/blindDate";

// Screen tests live here rather than beside the screen — see pitch.test.tsx.

jest.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: jest.fn() }) }));
jest.mock("~/hooks/useGuardedRoute", () => ({ useGuardedRoute: jest.fn() }));
jest.mock("~/lib/blindDate", () => ({
  ...jest.requireActual("~/lib/blindDate"),
  loadBlindDate: jest.fn(),
}));

const mockGuard = useGuardedRoute as jest.MockedFunction<typeof useGuardedRoute>;
const mockLoad = loadBlindDate as jest.MockedFunction<typeof loadBlindDate>;

const DATE = {
  partnerName: "Suzy Klein",
  venue: "Cafe Noir",
  dateTime: "2030-06-03T18:00:00.000Z",
  selfPhotoUrl: "https://example.test/a.jpg",
  partnerPhotoUrl: "https://example.test/b.jpg",
  // Only the fields the card reads. age and city are non-nullable in
  // UserProfileSchema, job is not — so the subline below is the "job dropped"
  // case rather than an arbitrary one.
  partnerProfile: {
    age: 23,
    city: "Tel Aviv",
    job: null,
    conflict_style: "calmly",
  },
} as unknown as Awaited<ReturnType<typeof loadBlindDate>>;

async function mount() {
  mockGuard.mockReturnValue({
    userId: "u-1",
    ready: true,
    state: null,
  } as unknown as ReturnType<typeof useGuardedRoute>);
  const utils = render(<BlindDate />);
  await act(async () => {});
  return utils;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoad.mockResolvedValue(DATE);
});

describe("the blind date card", () => {
  it("shows the venue, the partner and the heart", async () => {
    await mount();
    expect(screen.getByText("It's a date.")).toBeTruthy();
    expect(screen.getByText("Suzy Klein")).toBeTruthy();
    expect(screen.getByText("Cafe Noir")).toBeTruthy();
    expect(screen.getByLabelText("You and your match")).toBeTruthy();
  });

  // Hermes ships a cut-down Intl whose failure mode is a silently different
  // string rather than an error, so the time is hand-formatted — which is worth
  // asserting renders as something, on a value the user is committing to.
  it("renders the time", async () => {
    await mount();
    expect(screen.getByTestId("blind-date-time")).toBeTruthy();
    expect(screen.getByTestId("blind-date-time")).not.toHaveTextContent("Invalid");
  });

  it("uses the partner's first name on the photo caption", async () => {
    await mount();
    expect(screen.getByText("You + Suzy")).toBeTruthy();
  });

  // Dropped rather than left as an empty gap between separators.
  it("omits a profile field the partner does not have", async () => {
    await mount();
    expect(screen.getByText("23 · Tel Aviv")).toBeTruthy();
  });

  it("adds the personality line when the profile carries one", async () => {
    await mount();
    expect(screen.getByText("Handles conflict calmly.")).toBeTruthy();
  });

  // This screen only reads, and there is no cancel or reschedule (ADR-0012), so
  // a failed load has nothing to degrade to — a retry is the whole recovery.
  it("offers a retry when the load fails, in the server's words", async () => {
    mockLoad.mockRejectedValueOnce(new ServerReportedError("No date for this user"));
    await mount();

    expect(screen.getByText("No date for this user")).toBeTruthy();
    expect(screen.getByText("Can't load your date")).toBeTruthy();

    mockLoad.mockResolvedValue(DATE);
    await act(async () => {
      fireEvent.press(screen.getByText("Try again"));
    });

    await waitFor(() => expect(screen.getByText("It's a date.")).toBeTruthy());
  });

  it("falls back to its own wording for an error the server did not author", async () => {
    mockLoad.mockRejectedValue(new Error("socket hang up"));
    await mount();
    expect(screen.getByText("Could not load your date. Please try again.")).toBeTruthy();
  });
});
