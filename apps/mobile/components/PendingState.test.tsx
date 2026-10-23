import { render, screen } from "@testing-library/react-native";
import PendingState from "./PendingState";

// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above the imports.
jest.mock("react-native-reanimated", () => require("react-native-reanimated/mock"));

describe("PendingState", () => {
  // One component for the three places the match flow waits on someone else
  // (#464, #465), with the copy as the only difference between them — so the
  // thing worth asserting is that the copy is genuinely a prop.
  it("takes its copy from props", () => {
    render(<PendingState title="Times sent." body="We'll lock in your date." />);
    expect(screen.getByText("Times sent.")).toBeTruthy();
    expect(screen.getByText("We'll lock in your date.")).toBeTruthy();
  });

  // The promise the screen makes: nothing here can be hurried, but something is
  // happening. Also the only render RadarPulse gets under test.
  it("marks itself as pending", () => {
    render(<PendingState title="You said yeah." body="Waiting on your match." />);
    expect(screen.getByText("Pending")).toBeTruthy();
  });
});
