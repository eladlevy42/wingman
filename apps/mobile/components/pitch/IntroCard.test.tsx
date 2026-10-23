import { render, screen, fireEvent } from "@testing-library/react-native";
import IntroCard from "~/components/pitch/IntroCard";

// The card's entrance is a Reanimated `withTiming`, which drives an animation
// frame after render settles and so updates state outside act() — a wall of
// warnings on every assertion below. Reanimated ships a mock for exactly this;
// it runs the callbacks synchronously and leaves the tree at its final values,
// which is where these tests read it anyway. Motion is verified on device, not
// here.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factories are hoisted above the imports, so the mock cannot be pulled in with one.
jest.mock("react-native-reanimated", () => require("react-native-reanimated/mock"));

function renderCard(overrides: Partial<React.ComponentProps<typeof IntroCard>> = {}) {
  const onSendWish = jest.fn();
  const onMaybeLater = jest.fn();
  const utils = render(
    <IntroCard
      partnerName="Suzy"
      education="Design, Third year"
      totalQuestions={3}
      onSendWish={onSendWish}
      onMaybeLater={onMaybeLater}
      {...overrides}
    />
  );
  return { ...utils, onSendWish, onMaybeLater };
}

describe("IntroCard", () => {
  it("names the match and shows their education", () => {
    renderCard();
    expect(screen.getByTestId("intro-partner-name")).toHaveTextContent("Suzy");
    expect(screen.getByTestId("intro-education")).toHaveTextContent("Design, Third year");
  });

  it("reports the question allowance the mechanic will enforce", () => {
    renderCard();
    expect(screen.getByText(/Ask up to 3 questions/)).toBeTruthy();
  });

  // ADR-0022 puts name and education on this card and holds the photo back for
  // the decision screen (#464). Pinned so a later change has to be deliberate.
  it("does not reveal the photo", () => {
    renderCard();
    expect(screen.queryByTestId("intro-partner-photo")).toBeNull();
  });

  describe("the degraded card", () => {
    // Every field of MatchPhotoResponse is nullable by design — getMatchPhoto
    // answers nulls rather than erroring so a thin profile cannot block the
    // decision. The card has to stay usable, not just avoid throwing.
    it("falls back to a generic name when the partner has none", () => {
      renderCard({ partnerName: null });
      expect(screen.getByTestId("intro-partner-name")).toHaveTextContent("Your match");
    });

    // The heading opens a sentence and the placeholder sits inside one, so the
    // fallback cannot be a single string — sharing one put "Ask Your match
    // anything" on screen.
    it("lowercases the fallback where it appears mid-sentence", () => {
      renderCard({ partnerName: null });
      expect(screen.getByText("Ask your match anything…")).toBeTruthy();
    });

    it("drops the education line rather than showing an empty one", () => {
      renderCard({ education: null });
      expect(screen.queryByTestId("intro-education")).toBeNull();
    });

    it("still offers both actions with nothing revealed at all", () => {
      const { onSendWish, onMaybeLater } = renderCard({ partnerName: null, education: null });
      fireEvent.press(screen.getByTestId("send-a-wish"));
      fireEvent.press(screen.getByTestId("maybe-later"));
      expect(onSendWish).toHaveBeenCalledTimes(1);
      expect(onMaybeLater).toHaveBeenCalledTimes(1);
    });
  });

  it("routes the two actions to their own handlers", () => {
    const { onSendWish, onMaybeLater } = renderCard();
    fireEvent.press(screen.getByTestId("send-a-wish"));
    expect(onSendWish).toHaveBeenCalledTimes(1);
    expect(onMaybeLater).not.toHaveBeenCalled();

    fireEvent.press(screen.getByTestId("maybe-later"));
    expect(onMaybeLater).toHaveBeenCalledTimes(1);
  });
});
