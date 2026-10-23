import { z } from "zod";

export const UserProfileSchema = z.object({
  // Bucket 1 — Basics
  age: z.number().int().positive(),
  city: z.string().min(1),
  country: z.string().min(1),
  height: z.string().nullable(),
  job: z.string().nullable(),
  hometown: z.string().nullable(),
  // Defaults to null (like photoUrls) so existing profile fixtures that
  // predate this field still parse without every call site being updated.
  education: z.string().nullable().default(null),
  // Mirrors the wants tree's `appearance` (height/build/style) — see docs/adr/0021.
  // Defaults to null so profiles persisted before this field existed still parse.
  body_type: z.string().nullable().default(null),
  // A general self-description of looks and style, asked at the very end of
  // Phase 1 (just before build) so physical questions land naturally rather than
  // up front among the basics. Optional (like additionalNotes) so profile
  // fixtures that predate this field still typecheck and parse as-is.
  appearance: z.string().nullable().optional(),

  // Bucket 2 — Personality & Character
  conflict_style: z.string().nullable(),
  emotional_openness: z.string().nullable(),
  treatment_of_others: z.string().nullable(),
  // Mirrors the wants tree's `personality` list — see docs/adr/0021.
  // Defaults to empty so profiles persisted before this field existed still parse.
  personality_traits: z.array(z.string()).default([]),

  // Bucket 3 — Values & Life Priorities
  wants_kids: z.union([z.boolean(), z.literal("undecided")]).nullable(),
  kids_timeline: z.string().nullable(),
  faith: z.string().nullable(),
  current_motivation: z.string().nullable(),
  life_vision: z.string().nullable(),

  // Bucket 4 — Hobbies & Interests
  // `name` is the only sub-field anything reads: matching canonicalizes the
  // names to count shared hobbies, and negotiation never looks at the other
  // two. They are optional (#529) because hobbies are now collected as a
  // multi-select, which yields names alone — and because requiring them made
  // this the one strict-shaped field in the profile, so a partial extraction
  // failed validation and the whole answer was dropped. Interviews that do
  // capture them (free-text answers, existing fixtures and seed data) keep
  // storing all three.
  hobbies: z.array(
    z.object({
      name: z.string().min(1),
      centrality: z.string().optional(),
      solo_or_social: z.string().optional(),
    })
  ),

  // Bucket 5 — Lifestyle & Daily Reality
  typical_weekend: z.string().nullable(),
  social_energy: z.enum(["introvert", "extrovert", "ambivert"]).nullable(),
  social_circle: z.string().nullable(),

  // Photos (POC: placeholder URLs from seed; MVP: real uploads). Defaults to
  // empty since the interview agent does not collect photos.
  photoUrls: z.array(z.string().url()).default([]),

  // A genuine addition captured during the end-of-interview wrap-up (#251)
  // that didn't fit any existing field above. Optional (not defaulted) so
  // existing profile fixtures that predate this field still typecheck as-is.
  additionalNotes: z.string().nullable().optional(),
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

export const WantedProfileSchema = z.object({
  genderPreference: z.enum(["male", "female", "both", "other"]),
  ageRange: z
    .object({
      min: z.number().int().positive(),
      max: z.number().int().positive(),
    })
    .refine((range) => range.min <= range.max, {
      message: "ageRange.min must be less than or equal to ageRange.max",
      path: ["max"],
    }),
  maxDistanceKm: z.number().positive(),

  appearance: z.array(z.string()),
  personality: z.array(z.string()),
  lifestyle: z.array(z.string()),

  dealbreakers: z.array(z.string()),
  preferences: z.array(z.string()),
  compromises: z.array(z.string()),

  // Same wrap-up addendum concept as UserProfileSchema (#251) — a genuine
  // addition that didn't fit any existing field above.
  additionalNotes: z.string().nullable().optional(),
});

export type WantedProfile = z.infer<typeof WantedProfileSchema>;
