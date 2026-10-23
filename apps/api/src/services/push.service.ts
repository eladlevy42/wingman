import type { NotificationType } from "@wingman/shared";
import { pushTokenService } from "./pushToken.service";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// Expo rejects requests carrying more than 100 messages.
const MAX_MESSAGES_PER_REQUEST = 100;

// Same reasoning as notification.service.ts's timeout: push is best-effort and
// is awaited inside matching/scheduling sweeps that have already committed
// their writes. Node's fetch has no default timeout, so without this a hanging
// Expo endpoint would stall a sweep indefinitely.
const PUSH_TIMEOUT_MS = 5000;

// What the user actually sees on the lock screen. Server-owned presentation
// rather than a shared contract — the client renders nothing here, it only
// routes on `data`. Kept deliberately close to the in-app banner copy in
// apps/web's NOTIFICATION_TEXT so the two surfaces don't say different things
// about the same event.
const PUSH_CONTENT: Record<NotificationType, { title: string; body: string }> = {
  MATCH_FOUND: { title: "You've got a match", body: "Tap to meet them." },
  DATE_ASSIGNED: { title: "Your date is set", body: "Tap to see the details." },
  PRE_DATE_REMINDER: { title: "Your date is coming up", body: "Tap for the details." },
  DEBRIEF_NUDGE: { title: "How did it go?", body: "Barney wants to hear about your date." },
  CHECKIN_PROMPT: { title: "Barney's checking in", body: "Tap to catch up." },
};

interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const pushService = {
  // Never throws, for the same reason notificationService.send never throws:
  // by the time this runs the caller has already committed the state change
  // the notification is about. A failed push must not surface as an error on
  // work that succeeded.
  //
  // Platform-agnostic by construction — Expo's service fronts both APNs and
  // FCM, so iOS and Android differ only in the credentials configured on the
  // EAS project, not here. That is why iOS needs no separate code path despite
  // being unverified (#518).
  async sendToUser(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown>
  ): Promise<void> {
    let tokens: string[];
    try {
      tokens = await pushTokenService.listForUser(userId);
    } catch (error) {
      console.warn(`push: failed to load tokens for ${userId}:`, error);
      return;
    }
    // The overwhelmingly common case in local dev and in every test: nobody has
    // registered a device, so there is nothing to send and no network call.
    if (tokens.length === 0) return;

    const content = PUSH_CONTENT[type];
    const messages = tokens.map((to) => ({
      to,
      title: content.title,
      body: content.body,
      sound: "default" as const,
      // Only what the tap handler routes on. The full payload stays in the
      // persisted Notification row — push payloads are size-capped (~4KB) and
      // are not a data channel.
      data: { type, matchId: payload.matchId },
    }));

    const deadTokens: string[] = [];

    for (const batch of chunk(messages, MAX_MESSAGES_PER_REQUEST)) {
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "application/json",
        };
        // Optional but recommended by Expo: without it, anyone who learns a
        // token can send to that device. Absent in local dev, set for the pilot.
        if (process.env.EXPO_ACCESS_TOKEN) {
          headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
        }

        const response = await fetch(EXPO_PUSH_URL, {
          method: "POST",
          headers,
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        });

        if (!response.ok) {
          console.warn(`push: ${type} for ${userId} rejected with status ${response.status}`);
          continue;
        }

        const json = (await response.json()) as { data?: ExpoTicket[] };
        const tickets = json.data ?? [];
        tickets.forEach((ticket, i) => {
          if (ticket.status !== "error") return;
          console.warn(`push: ${type} ticket error: ${ticket.message ?? "unknown"}`);
          // The one error worth acting on: the app was uninstalled or the token
          // rotated. Expo asks senders to stop using these, and a row left in
          // place is retried on every future notification forever.
          if (ticket.details?.error === "DeviceNotRegistered") {
            const dead = batch[i]?.to;
            if (dead) deadTokens.push(dead);
          }
        });
      } catch (error) {
        console.warn(`push: failed to send ${type} to ${userId}:`, error);
      }
    }

    if (deadTokens.length > 0) {
      try {
        const pruned = await pushTokenService.prune(deadTokens);
        console.warn(`push: pruned ${pruned} unregistered device(s)`);
      } catch (error) {
        console.warn("push: failed to prune unregistered devices:", error);
      }
    }
  },
};
