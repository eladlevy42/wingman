import { prisma } from "@wingman/database";
import { NotificationRecordSchema } from "@wingman/shared";
import { pushService } from "./push.service";
import type {
  NotificationType,
  NotificationListResponse,
  NotificationRecord,
} from "@wingman/shared";

const NOTIFY_URL = process.env.NOTIFY_URL ?? "http://localhost:5173/mock/notify";

// Generous but bounded: notifications are mock/best-effort (PRODUCT_SPEC §9),
// so a slow or hanging endpoint must never stall the caller's flow (a core
// matching/scheduling/follow-up sweep) waiting on Node's fetch, which has no
// default timeout.
const NOTIFY_TIMEOUT_MS = 5000;

export const notificationService = {
  // Never throws: a notify failure is logged and swallowed instead of
  // propagating into the caller's flow — assignDate/decideMatch have
  // already committed their write by the time they notify, and
  // handleNegotiationOutcome/the follow-up sweeps have already advanced state,
  // so a rejected send() here would surface as a spurious error on work that
  // actually succeeded.
  //
  // Delivery (#357): the persisted row is the real channel — the web app
  // polls listNotifications and feeds new rows into its banner store. The
  // POST to NOTIFY_URL is kept only for the MSW-based test harness (a service
  // worker can't see cross-process HTTP, so it never reached real browsers).
  //
  // Push (#478) is dispatched from here rather than from the three call sites
  // (orchestration / scheduling / followup) because this function is already
  // the single chokepoint every notification passes through. Hooking the call
  // sites instead would mean three places to keep in sync and a silent gap the
  // day a fourth event type is added.
  //
  // Push is strictly an addition to the persisted row, never a replacement:
  // the row is written first and unconditionally, so a user with no registered
  // device — or one whose push simply fails — still sees the notification the
  // next time the app polls.
  async send(
    userId: string,
    type: NotificationType,
    payload: Record<string, unknown>
  ): Promise<void> {
    try {
      await prisma.notification.create({
        data: { userId, type, payload: JSON.stringify(payload) },
      });
    } catch (error) {
      console.warn(`notification: failed to persist ${type} for ${userId}:`, error);
    }
    try {
      const response = await fetch(NOTIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, type, payload }),
        signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.warn(`notification: ${type} to ${userId} rejected with status ${response.status}`);
      }
    } catch (error) {
      console.warn(`notification: failed to send ${type} to ${userId}:`, error);
    }
    await pushService.sendToUser(userId, type, payload);
  },

  // Rows created strictly after `since` (or all rows when omitted), oldest
  // first so the client can replay them into its banner queue in send order.
  // Malformed rows (bad JSON payload / unknown type) are skipped rather than
  // failing the whole poll.
  async listNotifications(userId: string, since?: Date): Promise<NotificationListResponse> {
    const rows = await prisma.notification.findMany({
      where: { userId, ...(since ? { createdAt: { gt: since } } : {}) },
      orderBy: { createdAt: "asc" },
    });

    const notifications: NotificationRecord[] = [];
    for (const row of rows) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        console.warn(`notification: skipping malformed row ${row.id}`);
        continue;
      }
      const parsed = NotificationRecordSchema.safeParse({
        id: row.id,
        userId: row.userId,
        type: row.type,
        payload,
        createdAt: row.createdAt.toISOString(),
      });
      if (!parsed.success) {
        console.warn(`notification: skipping malformed row ${row.id}`);
        continue;
      }
      notifications.push(parsed.data);
    }
    return { notifications };
  },
};
