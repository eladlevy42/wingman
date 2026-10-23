import AsyncStorage from "@react-native-async-storage/async-storage";
import { addNotification, NotificationListResponseSchema } from "@wingman/shared";
import { apiRequest } from "./api";

/**
 * The notification delivery channel for the app in the foreground (#439).
 *
 * Mobile's counterpart of web's useNotificationPoll, and polling for the same
 * reason: the api pushes nothing, and adding SSE would mean a React Native
 * polyfill for a transport the server does not speak. Push (#479) covers the
 * app being closed; this covers it being open.
 *
 * The React wrapper (hooks/useNotificationPoll) owns only the timer and the
 * foreground gating. Everything that can be got wrong — the cursor, the
 * overlap guard, deciding what counts as already-seen — lives here, where it
 * can be tested without a device. Same split as guardOutcome/useGuardedRoute.
 */

// Per-user AsyncStorage key holding the createdAt of the newest notification
// already delivered to the store — the `since` cursor for the next poll.
// Per-user rather than global because two accounts on one handset must not
// inherit each other's read position.
export function notificationCursorKey(userId: string): string {
  return `wingman:notifications-since:${userId}`;
}

/**
 * Starts the cursor at `now` the first time this user ever polls on this
 * device, so their entire notification history does not arrive at once as a
 * stack of fresh banners.
 *
 * Only ever writes when there is nothing stored — a second call must not move
 * a cursor that real polls have advanced, or every relaunch would silently
 * skip whatever arrived while the app was closed.
 */
export async function primeNotificationCursor(userId: string, now: Date): Promise<void> {
  const key = notificationCursorKey(userId);
  if ((await AsyncStorage.getItem(key)) === null) {
    await AsyncStorage.setItem(key, now.toISOString());
  }
}

/**
 * One poll: fetch everything created after the cursor, hand it to the store,
 * and advance the cursor past the last row.
 *
 * Returns how many notifications were delivered, which is what the tests
 * assert on and what makes "the same row is never delivered twice" checkable.
 *
 * Never throws. A poll runs on a timer with nobody waiting on it, and a failed
 * one simply means the next tick tries again from the same cursor — a dropped
 * notification is recoverable, a crash inside an interval is not.
 *
 * `stillCurrent` is re-asked after the response lands and before anything is
 * delivered, because the request is in flight for long enough that the user can
 * sign out inside it: the tick's own check happens before the fetch, and
 * clearUser empties a store this batch would then refill with the previous
 * account's notifications. Answering false drops the batch and leaves the
 * cursor where it was, so those rows are still there if that user signs back
 * in. The default keeps the function callable with just a userId in tests.
 */
export async function pollNotificationsOnce(
  userId: string,
  stillCurrent: () => Promise<boolean> = async () => true
): Promise<number> {
  const key = notificationCursorKey(userId);
  try {
    const since = (await AsyncStorage.getItem(key)) ?? "";
    const { notifications } = await apiRequest(
      `/api/users/${userId}/notifications?since=${encodeURIComponent(since)}`,
      { schema: NotificationListResponseSchema }
    );

    if (!(await stillCurrent())) return 0;

    for (const n of notifications) {
      addNotification({ userId: n.userId, type: n.type, payload: n.payload });
    }

    // Advanced once, from the last row, rather than inside the loop: the rows
    // arrive newest-last and a write per row is a storage round-trip per
    // notification for no benefit. If the write fails, the whole batch is
    // re-delivered next tick — visible, but not lost, which is the right way
    // round for a notification.
    const newest = notifications[notifications.length - 1];
    if (newest) await AsyncStorage.setItem(key, newest.createdAt);

    return notifications.length;
  } catch {
    // Transient errors retry on the next tick. The api being unreachable is
    // the normal state of a phone that has walked out of wifi range.
    return 0;
  }
}
