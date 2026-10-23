import { render } from "@testing-library/react-native";
import { Text } from "react-native";

const mockUsePathname = jest.fn();
jest.mock("expo-router", () => ({ usePathname: () => mockUsePathname() }));
jest.mock("~/lib/telemetry", () => ({ trackScreen: jest.fn() }));

import { useScreenTracking } from "./useScreenTracking";
import { trackScreen } from "~/lib/telemetry";

const mockTrackScreen = trackScreen as jest.MockedFunction<typeof trackScreen>;

function Harness() {
  useScreenTracking();
  return <Text>screen</Text>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUsePathname.mockReturnValue("/register");
});

describe("useScreenTracking (#554)", () => {
  it("records the route it mounted on", () => {
    render(<Harness />);

    expect(mockTrackScreen).toHaveBeenCalledWith("/register");
  });

  it("records the new route on navigation", () => {
    const view = render(<Harness />);

    mockUsePathname.mockReturnValue("/barney/phase1");
    view.rerender(<Harness />);

    expect(mockTrackScreen).toHaveBeenNthCalledWith(2, "/barney/phase1");
  });

  it("does not re-record on a render that did not change the route", () => {
    const view = render(<Harness />);
    view.rerender(<Harness />);

    expect(mockTrackScreen).toHaveBeenCalledTimes(1);
  });
});
