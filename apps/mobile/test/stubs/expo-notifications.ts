import { vi } from "vitest";

// Stands in for expo-notifications under Vitest, which has no native module to
// call. Every export is a spy so a test can drive the permission/token paths
// that decide whether a device ends up registered.
//
// Defaults describe the happy path: permission already granted, a token minted.
// Tests that care about the refusal paths override these.
export const AndroidImportance = { HIGH: 4 } as const;

export const setNotificationChannelAsync = vi.fn().mockResolvedValue(undefined);
export const setNotificationHandler = vi.fn();
export const getPermissionsAsync = vi.fn().mockResolvedValue({ granted: true, canAskAgain: true });
export const requestPermissionsAsync = vi
  .fn()
  .mockResolvedValue({ granted: true, canAskAgain: true });
export const getExpoPushTokenAsync = vi
  .fn()
  .mockResolvedValue({ data: "ExponentPushToken[test-token]" });
export const addNotificationResponseReceivedListener = vi.fn().mockReturnValue({
  remove: vi.fn(),
});

export function __reset(): void {
  setNotificationChannelAsync.mockClear().mockResolvedValue(undefined);
  setNotificationHandler.mockClear();
  getPermissionsAsync.mockClear().mockResolvedValue({ granted: true, canAskAgain: true });
  requestPermissionsAsync.mockClear().mockResolvedValue({ granted: true, canAskAgain: true });
  getExpoPushTokenAsync.mockClear().mockResolvedValue({ data: "ExponentPushToken[test-token]" });
  addNotificationResponseReceivedListener.mockClear().mockReturnValue({ remove: vi.fn() });
}
