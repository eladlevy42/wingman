import { render, screen, fireEvent } from "@testing-library/react-native";
import ScreenFailure from "~/components/ScreenFailure";

// #508 pulled three hand-rolled failure screens into this one component. What
// stayed per-screen is the title, the body and the escape hatch — so what is
// worth pinning here is that each of those actually reaches the screen, and
// that the two buttons are wired to different handlers. The bug this guards
// against is the one #508 was filed about: the retry and the escape drifting
// into each other.
describe("ScreenFailure", () => {
  function renderScreen(overrides: Partial<React.ComponentProps<typeof ScreenFailure>> = {}) {
    const onRetry = jest.fn();
    const onEscape = jest.fn();
    render(
      <ScreenFailure
        title="Couldn't start the interview"
        body="Barney didn't pick up. This is on us, not you."
        onRetry={onRetry}
        escape={{ label: "Sign out", onPress: onEscape }}
        {...overrides}
      />
    );
    return { onRetry, onEscape };
  }

  it("shows the title and body it was given", () => {
    renderScreen();
    expect(screen.getByText("Couldn't start the interview")).toBeOnTheScreen();
    expect(screen.getByText("Barney didn't pick up. This is on us, not you.")).toBeOnTheScreen();
  });

  it("defaults the retry label but lets a screen override it", () => {
    renderScreen();
    expect(screen.getByText("Try again")).toBeOnTheScreen();

    screen.unmount();
    renderScreen({ retryLabel: "Reconnect" });
    expect(screen.getByText("Reconnect")).toBeOnTheScreen();
    expect(screen.queryByText("Try again")).not.toBeOnTheScreen();
  });

  it("routes retry and escape to their own handlers", () => {
    const { onRetry, onEscape } = renderScreen();

    fireEvent.press(screen.getByText("Try again"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onEscape).not.toHaveBeenCalled();

    fireEvent.press(screen.getByText("Sign out"));
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
