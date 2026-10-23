// Stands in for react-native under Vitest. Only the handful of members the
// non-rendering logic actually touches — Platform is read by lib/push.ts to
// decide the platform string it registers and whether to create an Android
// channel, and AppState by hooks/useNotificationPoll to stop polling while the
// app is backgrounded. Rendering stays out of scope (see vitest.config.ts).
export const Platform = {
  // Android is the honest default: it is the platform push is verified on
  // (#480), iOS being unverified until #518 closes.
  OS: "android" as "ios" | "android",
  select: <T>(spec: { ios?: T; android?: T; default?: T }): T | undefined =>
    spec.android ?? spec.default,
};

// The foreground/background signal useNotificationPoll gates on (#439). Tests
// drive it through `__emit` rather than waiting on a real app lifecycle.
type AppStateStatus = "active" | "background" | "inactive";

const appStateListeners = new Set<(status: AppStateStatus) => void>();

export const AppState = {
  currentState: "active" as AppStateStatus,
  addEventListener(
    type: "change",
    listener: (status: AppStateStatus) => void
  ): { remove: () => void } {
    if (type !== "change") throw new Error(`AppState stub: unsupported event "${type}"`);
    appStateListeners.add(listener);
    return { remove: () => appStateListeners.delete(listener) };
  },
  // Test-only, as with the storage stub's __reset.
  __emit(status: AppStateStatus): void {
    AppState.currentState = status;
    appStateListeners.forEach((l) => l(status));
  },
  __listenerCount(): number {
    return appStateListeners.size;
  },
};
