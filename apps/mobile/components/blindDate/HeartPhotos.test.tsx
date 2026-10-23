import { render, screen } from "@testing-library/react-native";
import HeartPhotos from "./HeartPhotos";

const heart = () => screen.getByLabelText("You and your match");

// The api answers an empty string rather than failing when someone has no
// photo, so every combination here is a real state of the date card — and a
// half-empty heart is a worse card than a single filled one.
describe("HeartPhotos", () => {
  it("draws both photos when both exist", () => {
    render(
      <HeartPhotos selfUrl="https://example.test/a.jpg" partnerUrl="https://example.test/b.jpg" />
    );
    expect(heart()).toBeTruthy();
  });

  it.each([
    ["only the partner has one", "", "https://example.test/b.jpg"],
    ["only the user has one", "https://example.test/a.jpg", ""],
    ["neither has one", "", ""],
  ])("still draws a heart when %s", (_label, selfUrl, partnerUrl) => {
    render(<HeartPhotos selfUrl={selfUrl} partnerUrl={partnerUrl} />);
    expect(heart()).toBeTruthy();
  });
});
