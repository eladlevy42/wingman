import { z } from "zod";
import { NotificationTypeSchema } from "./notification";

// The two platforms Expo's push service fronts. Stored on PushToken so a
// delivery failure that only affects one platform is diagnosable, and so iOS
// rows are identifiable while iOS push remains unverified (#518).
export const PushPlatformSchema = z.enum(["ios", "android"]);

export type PushPlatform = z.infer<typeof PushPlatformSchema>;

// Expo hands out tokens in one of two shapes depending on SDK vintage:
// `ExponentPushToken[...]` (current) and `ExpoPushToken[...]` (older). Both are
// accepted by Expo's send endpoint, so both are accepted here.
//
// Validating the shape at the boundary is worth the strictness: a device that
// posts a FCM/APNs token directly — the natural mistake when wiring this up —
// would otherwise be stored happily and then fail silently at send time, which
// looks identical to "the user has notifications turned off".
export const ExpoPushTokenSchema = z
  .string()
  .regex(/^Expo(nent)?PushToken\[[^\]\s]+\]$/, "Not an Expo push token");

export const RegisterPushTokenRequestSchema = z.object({
  token: ExpoPushTokenSchema,
  platform: PushPlatformSchema,
});

export type RegisterPushTokenRequest = z.infer<typeof RegisterPushTokenRequestSchema>;

export const UnregisterPushTokenRequestSchema = z.object({
  token: ExpoPushTokenSchema,
});

export type UnregisterPushTokenRequest = z.infer<typeof UnregisterPushTokenRequestSchema>;

export const PushTokenRecordSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  token: ExpoPushTokenSchema,
  platform: PushPlatformSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PushTokenRecord = z.infer<typeof PushTokenRecordSchema>;

// What a tapped push carries back into the app. Mirrors the persisted
// Notification row's shape so the mobile tap handler and the in-app poll can
// share one routing function rather than two that drift.
export const PushDataSchema = z.object({
  type: NotificationTypeSchema,
  matchId: z.string().optional(),
});

export type PushData = z.infer<typeof PushDataSchema>;
