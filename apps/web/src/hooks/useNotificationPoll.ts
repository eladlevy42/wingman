import { useEffect } from "react";
import {
  addNotification,
  NotificationListResponseSchema,
  UserResponseSchema,
} from "@wingman/shared";

const POLL_INTERVAL_MS = 5000;

// localStorage key (per user) holding the createdAt of the newest processed
// notification — the `since` cursor for the next poll. Persisted so
// notifications sent while the app was closed surface on the next open, and
// so a reload doesn't replay banners already shown.
function cursorKey(userId: string): string {
  return `wingman:notifications-since:${userId}`;
}

function readStoredUserId(): string | null {
  const raw = localStorage.getItem("user");
  if (!raw) return null;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = UserResponseSchema.safeParse(stored);
  return parsed.success ? parsed.data.id : null;
}

// The real notification delivery channel (#357): polls the persisted rows and
// feeds new ones into the existing banner/badge store. Mounted once in
// AppLayout so every screen that shows the banner also receives them. The
// server pushes nothing — the old POST-to-MSW path only ever worked inside
// test pages, so polling is what makes notifications real.
export function useNotificationPoll(): void {
  useEffect(() => {
    const userId = readStoredUserId();
    if (!userId) return;

    // First ever poll for this user: start the cursor at "now" instead of
    // replaying their entire history as fresh banners.
    if (!localStorage.getItem(cursorKey(userId))) {
      localStorage.setItem(cursorKey(userId), new Date().toISOString());
    }

    let cancelled = false;
    let inFlight = false;

    async function poll() {
      // Guards against overlapping polls: if a request takes longer than
      // POLL_INTERVAL_MS, the next tick must not fire a duplicate request
      // against the same stale cursor, which would double-deliver rows.
      if (inFlight) return;
      inFlight = true;
      try {
        const since = localStorage.getItem(cursorKey(userId!)) ?? "";
        const res = await fetch(
          `/api/users/${userId}/notifications?since=${encodeURIComponent(since)}`
        );
        if (!res.ok || cancelled) return;
        const parsed = NotificationListResponseSchema.safeParse(await res.json());
        if (!parsed.success || cancelled) return;
        for (const n of parsed.data.notifications) {
          addNotification({ userId: n.userId, type: n.type, payload: n.payload });
          localStorage.setItem(cursorKey(userId!), n.createdAt);
        }
      } catch {
        // Transient errors retry on the next tick.
      } finally {
        inFlight = false;
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
}
