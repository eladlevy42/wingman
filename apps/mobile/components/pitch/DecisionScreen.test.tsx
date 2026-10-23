import { render, screen, fireEvent } from "@testing-library/react-native";
import DecisionScreen from "./DecisionScreen";

const PROPS = {
  matchPhotoUrl: null,
  partnerName: "Suzy",
  education: "Design, Third year",
  decisionError: null,
  decisionPending: false,
  onDecide: jest.fn(),
};

beforeEach(() => jest.clearAllMocks());

describe("DecisionScreen", () => {
  it("names the match in the question", () => {
    render(<DecisionScreen {...PROPS} />);
    expect(screen.getByText(/Suzy/)).toBeTruthy();
  });

  // The pitch is blind until here, and the photo is the reveal — but its
  // absence is not an error state. The api answers a null photoUrl rather than
  // failing when the partner never uploaded one, precisely so the decision goes
  // ahead without it.
  it("decides without a photo", () => {
    render(<DecisionScreen {...PROPS} />);
    expect(screen.queryByLabelText("Your match")).toBeNull();
    expect(screen.getByTestId("decide-yeah")).toBeTruthy();
    expect(screen.getByTestId("decide-nah")).toBeTruthy();
  });

  it("shows the photo when there is one", () => {
    render(<DecisionScreen {...PROPS} matchPhotoUrl="https://example.test/p.jpg" />);
    expect(screen.getByLabelText("Your match")).toBeTruthy();
  });

  // Falls back rather than rendering "Is null your kind of person?" — the
  // reveal is allowed to fail and this screen still has to be answerable.
  it("still asks the question when the reveal degraded", () => {
    render(<DecisionScreen {...PROPS} partnerName={null} education={null} />);
    expect(screen.getByText(/this/)).toBeTruthy();
    expect(screen.getByTestId("decide-yeah")).toBeTruthy();
  });

  it.each([
    ["decide-yeah", "yeah"],
    ["decide-nah", "nah"],
  ])("reports %s as %s", (testID, expected) => {
    render(<DecisionScreen {...PROPS} />);
    fireEvent.press(screen.getByTestId(testID));
    expect(PROPS.onDecide).toHaveBeenCalledWith(expected);
  });

  it("shuts both buttons while a decision is in flight", () => {
    render(<DecisionScreen {...PROPS} decisionPending />);
    fireEvent.press(screen.getByTestId("decide-yeah"));
    fireEvent.press(screen.getByTestId("decide-nah"));
    expect(PROPS.onDecide).not.toHaveBeenCalled();
  });

  it("shows a decision error verbatim", () => {
    render(<DecisionScreen {...PROPS} decisionError="Match not found" />);
    expect(screen.getByTestId("decision-error")).toHaveTextContent("Match not found");
  });
});
