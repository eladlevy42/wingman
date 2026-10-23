import { z } from "zod";
import { UserProfileSchema } from "./profile";

// Returned by GET /api/users/:id/blind-date once a user reaches the
// DATE_ASSIGNED matching state (#57, docs/adr/0012, docs/adr/0015).
export const BlindDateResponseSchema = z.object({
  venue: z.string(),
  dateTime: z.string().datetime(),
  partnerName: z.string(),
  partnerPhotoUrl: z.string(),
  // The logged-in user's own photo (#248) — the date card pairs it with the
  // partner's inside a heart. Empty string if the user somehow has no photo,
  // so the card degrades to showing just the partner's half.
  selfPhotoUrl: z.string(),
  partnerProfile: UserProfileSchema,
});

export type BlindDateResponse = z.infer<typeof BlindDateResponseSchema>;
