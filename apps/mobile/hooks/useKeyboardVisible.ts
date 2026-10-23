import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/**
 * True while the soft keyboard is on screen.
 *
 * Needed because the safe-area bottom inset and the keyboard must never both
 * pad the composer: KeyboardAvoidingView already lifts it by the keyboard's
 * height, so keeping the home-indicator inset as well leaves a dead ~34px strip
 * between the input and the keyboard. Callers drop their bottom inset while this
 * is true.
 *
 * iOS gets the `Will` events so the layout change rides the same animation as
 * the keyboard; Android only emits the `Did` events.
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSub = Keyboard.addListener(showEvent, () => setVisible(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setVisible(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return visible;
}
