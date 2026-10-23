import { z } from "zod";

export const NotificationTypeSchema = z.enum([
  "MATCH_FOUND",
  "DATE_ASSIGNED",
  "PRE_DATE_REMINDER",
  "DEBRIEF_NUDGE",
  "CHECKIN_PROMPT",
]);

export type NotificationType = z.infer<typeof NotificationTypeSchema>;

export const NotificationPayloadSchema = z.object({
  userId: z.string(),
  type: NotificationTypeSchema,
  payload: z.record(z.unknown()),
});

export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;

// One persisted notification row (#357) — what GET
// /api/users/:id/notifications returns. Persistence + polling is the real
// delivery channel; the old push-to-MSW-mock path only ever worked inside
// test pages.
export const NotificationRecordSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  type: NotificationTypeSchema,
  payload: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});

export type NotificationRecord = z.infer<typeof NotificationRecordSchema>;

export const NotificationListResponseSchema = z.object({
  notifications: z.array(NotificationRecordSchema),
});

export type NotificationListResponse = z.infer<typeof NotificationListResponseSchema>;

// `since` query param for GET /api/users/:id/notifications. A repeated query
// key makes Express parse `since` as an array rather than a string — this
// schema rejects that (and any other non-ISO-datetime value) instead of
// silently falling through to "no cursor" (full history).
export const NotificationsSinceQuerySchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().datetime().optional()
);
