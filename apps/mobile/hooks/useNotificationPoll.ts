import { useEffect } from "react";
import { AppState } from "react-native";
import { pollNotificationsOnce, primeNotificationCursor } from "~/lib/notificationPoll";
import { loadUser } from "~/lib/session";

const POLL_INTERVAL_MS = 5000;

/**
 * Keeps the notification store fed while the app is open (#439).
 *
 * Mounted once in the root layout rather than per screen, which is where this
 * departs from web (web mounts it in AppLayout, so only Waiting and Pitch
 * poll). Two reasons it has to be global here:
 *
 *  - #439 turns off the OS-drawn banner for foreground notifications, since an
 *    in-app one now exists. If polling only ran on the waiting screen, a
 *    notification arriving anywhere else would be shown by neither.
 *  - The history panel claims to list "every notification received this
 *    session". That is only true if something was listening the whole session.
 *
 * Polling stops while the app is backgrounded and resumes — with an immediate
 * poll, not after a full interval — on return. A backgrounded timer is
 * throttled or suspended by both platforms anyway, so the alternative is not
 * "polls in the background", it is "polls unpredictably and then makes the user
 * wait five seconds for a notification that already arrived". Push covers the
 * app being closed; this covers it being open.
 */
export function useNotificationPoll(): void {
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    // The user this loop has already primed a cursor for. Not the user it polls
    // for — that is re-read every tick; see below.
    let primedFor: string | null = null;

    async function poll() {
      // Overlap guard: a poll slower than POLL_INTERVAL_MS would otherwise let
      // the next tick fire against the same un-advanced cursor and deliver
      // every row twice.
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        // Deliberately re-read per tick rather than captured once when the
        // effect ran. This hook is mounted in the root layout, which does not
        // unmount across sign-out and sign-in — so a captured id would still be
        // the *previous* user's after someone switches accounts on this
        // handset, and this loop would pour their matches into the new
        // session's banner. Same hazard the interview session (#496) and the
        // push token (#479) each had to close, and the reason clearUser empties
        // the store.
        const user = await loadUser();
        if (!user || cancelled) return;

        if (primedFor !== user.id) {
          // Starts the cursor at "now" the first time this device ever polls
          // for this user, so their history does not arrive at once as a stack
          // of banners. Idempotent, so re-running it for a returning user
          // leaves the position real polls have reached alone.
          await primeNotificationCursor(user.id, new Date());
          if (cancelled) return;
          primedFor = user.id;
        }

        // The same guard again, on the far side of the request: a sign-out
        // during the round trip runs clearUser, which empties the store — and
        // without this, the batch already in flight would refill it with the
        // signed-out user's notifications a moment later.
        await pollNotificationsOnce(user.id, async () => {
          if (cancelled) return false;
          const current = await loadUser();
          return current?.id === user.id;
        });
      } finally {
        inFlight = false;
      }
    }

    function start() {
      if (cancelled) return;
      // Polls immediately, then ensures the interval. Both guarded separately
      // so that returning to the foreground always costs one poll right away
      // rather than up to a full interval of silence.
      void poll();
      if (interval === null) interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    }

    function stop() {
      if (interval === null) return;
      clearInterval(interval);
      interval = null;
    }

    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") start();
      else stop();
    });

    // Runs whether or not anyone is signed in yet: a signed-out tick is one
    // AsyncStorage read that returns early, and it means signing in starts
    // delivering notifications without needing the root layout to remount —
    // which it does not do.
    start();

    return () => {
      cancelled = true;
      stop();
      subscription.remove();
    };
  }, []);
}
