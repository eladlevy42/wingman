import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import Login from "~/app/login";
import Register from "~/app/register";
import Verify from "~/app/verify";

// Lives in `__tests__/` rather than beside the screens for the reason
// __tests__/pitch.test.tsx documents: expo-router treats every file under
// `app/` as a route, so a colocated screen test ships in the app bundle.
//
// All three screens get the same one-line change in #554, and the thing worth
// asserting is the same on each: the tap is recorded BEFORE validation, so a
// form abandoned at the first error is still in the funnel. Covering one and
// waving the others through would leave two of the three untested.

jest.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => ({}),
  Link: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("~/lib/session", () => ({ saveUser: jest.fn(), loadUser: jest.fn() }));
jest.mock("~/lib/telemetry", () => ({ trackAction: jest.fn() }));

import { trackAction } from "~/lib/telemetry";

const mockTrackAction = trackAction as jest.MockedFunction<typeof trackAction>;

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockRejectedValue(new Error("no network in this test"));
});

const CASES = [
  { name: "Login", Screen: Login, submit: /^sign in$/i, path: "/login", action: "login_submitted" },
  {
    name: "Register",
    Screen: Register,
    submit: /^create account$/i,
    path: "/register",
    action: "register_submitted",
  },
  {
    name: "Verify",
    Screen: Verify,
    submit: /^verify$/i,
    path: "/verify",
    action: "verification_submitted",
  },
] as const;

describe.each(CASES)("$name — funnel telemetry (#554)", ({ Screen, submit, path, action }) => {
  it("records the submit tap even when the form never reaches the api", async () => {
    render(<Screen />);

    // Left empty on purpose: this is the drop-off the server cannot see, and
    // the reason the tap is tracked before validation rather than after it.
    fireEvent.press(screen.getAllByText(submit)[0]!);

    await waitFor(() => expect(mockTrackAction).toHaveBeenCalledWith(path, action));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("records the tap once per submit", async () => {
    render(<Screen />);

    fireEvent.press(screen.getAllByText(submit)[0]!);

    await waitFor(() => expect(mockTrackAction).toHaveBeenCalledTimes(1));
  });
});
