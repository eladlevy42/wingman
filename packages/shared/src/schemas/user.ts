import { z } from "zod";
import { FollowUpStateSchema } from "./followup";

export const GenderSchema = z.enum(["male", "female", "other"]);

export const LookingForSchema = z.enum(["male", "female", "both", "other"]);

// RFC 5321 caps a full email address at 254 characters (#227).
const MAX_EMAIL_LENGTH = 254;

export const EmailSchema = z.string().email().max(MAX_EMAIL_LENGTH);

// Universities currently open to Wingman (#275), checked on the university
// verification step. For now, Tel Aviv University only. To open access to
// another campus, add its base domain here — an entry matches the domain itself
// and any subdomain (so "tau.ac.il" covers the student mailbox domain
// "mail.tau.ac.il" and staff domains like "tauex.tau.ac.il"). Kept lowercase;
// matching lowercases the candidate.
export const ALLOWED_UNIVERSITY_DOMAINS = ["tau.ac.il"] as const;

// True when the email's domain is one of the allowed university domains, or a
// subdomain of one. The leading-dot guard on the subdomain check prevents a
// look-alike domain (e.g. "eviltau.ac.il" or "tau.ac.il.evil.com") from slipping
// through — only a real sub-label of an allowed domain matches.
export function isUniversityEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at === -1) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return ALLOWED_UNIVERSITY_DOMAINS.some(
    (allowed) => domain === allowed || domain.endsWith(`.${allowed}`)
  );
}

// Shown when a non-university (or wrong-university) email is entered on the
// university verification step.
export const UNIVERSITY_EMAIL_MESSAGE =
  "Wingman is currently open to Tel Aviv University students only — please use your university email (e.g. you@mail.tau.ac.il).";

const MAX_NAME_LENGTH = 200;
const MAX_PHONE_LENGTH = 32;

// The shared user fields, with a plain (non-gated) email. UserResponseSchema
// derives from this so that reading an already-registered user never re-applies
// the university-email gate — otherwise a pre-existing non-university account
// could no longer be loaded.
const UserFieldsSchema = z.object({
  email: EmailSchema,
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  phone: z.string().trim().min(1).max(MAX_PHONE_LENGTH),
  gender: GenderSchema,
});

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const MAX_STUDENT_ID_LENGTH = 64;

// The account login password, chosen on the "Sign up with email" step (#277).
// The API stores only its bcrypt hash. This is a separate credential from the
// university password on the verification step (StudentAuthInputSchema).
export const PasswordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);

// Sign-up email is any valid email (a personal Google/Microsoft account is
// fine). Proving the person is a current student happens later, on the "Verify
// Your University" step (StudentAuthInputSchema), not here (#275). The account
// password is set here (#277).
export const RegisterInputSchema = UserFieldsSchema.extend({
  password: PasswordSchema,
});

// Login takes the email plus the account password chosen at sign-up (#277). The
// password is only required to be non-empty here — its real correctness is
// checked by the API via bcrypt against the stored hash, so a wrong password
// surfaces as an auth failure rather than a validation error.
export const LoginInputSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1, "Password is required"),
});

// Account erasure (#561, docs/adr/0040). Deletion is irreversible and takes the
// account's own data with it, so the endpoint re-checks the account password
// rather than trusting a path parameter: a user id is not a secret — GET
// /api/users/:id/state hands a caller their match's id — and without this any
// client holding one could erase somebody else's account. Only non-emptiness is
// checked here; correctness is bcrypt against the stored hash, so a wrong
// password is an auth failure rather than a validation error (as at login).
export const DeleteAccountRequestSchema = z
  .object({
    password: z.string().min(1, "Password is required"),
  })
  .strict();

export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequestSchema>;

// A user id in a path parameter. Every id in this system is a uuid
// (Prisma @default(uuid()), and the pinned fixture/seed ids are uuids too), so
// anything else is a malformed request — worth rejecting before it reaches a
// destructive query rather than letting it fall through as a 404.
export const UserIdParamSchema = z.string().uuid();

// The "Verify Your University" step, completed right after sign-up (#275). The
// university email must be a recognised university address (currently Tel Aviv
// University only); the student id is captured; the password becomes the login
// credential (the API stores only its bcrypt hash). Gated in the shared schema
// so both the web page and the API reject a non-university email — the UI can be
// bypassed, the server-side parse cannot.
export const StudentAuthInputSchema = z.object({
  // The university rule only applies to an otherwise-valid email: a malformed or
  // empty value defers to EmailSchema's "Invalid email" message rather than
  // confusingly telling the user to use a university address. (In this Zod
  // version a refine still runs when the base .email() check fails, so the guard
  // is explicit.)
  universityEmail: EmailSchema.refine(
    (value) => !EmailSchema.safeParse(value).success || isUniversityEmail(value),
    { message: UNIVERSITY_EMAIL_MESSAGE }
  ),
  studentId: z.string().trim().min(1).max(MAX_STUDENT_ID_LENGTH),
  password: PasswordSchema,
});

export type StudentAuthInput = z.infer<typeof StudentAuthInputSchema>;

// Where a user sits in the matching engine after onboarding completes.
// See docs/adr/0002 for the distinction between matching state and onboarding progress.
// DATE_ASSIGNED (#57, docs/adr/0012) is reached once decision.service.ts's resolver
// finds both users said "yeah" and assigns a Blind Date.
// CHOOSING_TIMES (#248) sits between MATCHED and DATE_ASSIGNED: both users said
// "yeah", and each must now pick their available times before a date is set.
export const MatchingStateSchema = z.enum([
  "IDLE",
  "WAITING",
  "MATCHED",
  "CHOOSING_TIMES",
  "REJECTED",
  "DATE_ASSIGNED",
]);

// Returned by GET /api/users/:id/state, consumed by the login redirect logic.
// hasProfile reflects onboarding progress (Phase 1 complete); matchingState drives
// the post-onboarding screens. matchedWith and matchId are the other user's id and
// the Match record's id once matchingState is MATCHED, and are omitted otherwise.
// followUpState is the FollowUp row's state for that same match (#67) — omitted
// when there is no FollowUp row yet (e.g. no date assigned). Debrief.tsx (#77)
// uses it to know when to auto-trigger a debrief session.
// The choose-your-times fields (#248) are only meaningful while matchingState
// is CHOOSING_TIMES, and which ones matter depends on timeRole:
//   - "proposer": picks up to three of candidateSlots; hasSubmittedAvailability
//     is true once they have, so their client shows the waiting state.
//   - "chooser": picks exactly one of proposedSlots (empty until the proposer
//     has picked, i.e. the chooser is still waiting).
// All omitted outside CHOOSING_TIMES.
export const UserStateResponseSchema = z.object({
  matchingState: MatchingStateSchema,
  hasProfile: z.boolean(),
  // False until the university-verification step (/authenticate) has stored a
  // universityEmail on the account (#329). The backend always sends this;
  // optional here only for back-compat with older test fixtures — redirect
  // logic (redirectPathForState) is fail-closed and treats a missing value
  // the same as false.
  universityVerified: z.boolean().optional(),
  // False until the user has uploaded a photo (#509). Completing Phase 2 flips
  // the user to WAITING server-side before the upload is a separate call, so
  // without this the clients had nothing to branch on and a user killed in that
  // gap sailed past the photo step forever.
  //
  // Optional for the same back-compat reason as universityVerified, but read
  // the *opposite* way round: only an explicit `false` sends anyone back to the
  // photo step. Fail-closed would be wrong here — universityVerified guards who
  // is allowed in at all, so a missing value there must not open the gate,
  // whereas a missing value here would trap users who do have a photo on a
  // screen asking for one they already gave. The api always sends it.
  hasPhoto: z.boolean().optional(),
  matchedWith: z.string().uuid().optional(),
  matchId: z.string().uuid().optional(),
  followUpState: FollowUpStateSchema.optional(),
  timeRole: z.enum(["proposer", "chooser"]).optional(),
  candidateSlots: z.array(z.string().datetime()).optional(),
  proposedSlots: z.array(z.string().datetime()).optional(),
  hasSubmittedAvailability: z.boolean().optional(),
});

export type UserStateResponse = z.infer<typeof UserStateResponseSchema>;

// Ground truth for Eval Track 1 (precision@5) — up to 5 intentionally-designed
// compatible user IDs per seeded user, not random. Capped, not exact-length:
// once expectedMatches is computed with the same hard gates (gender/ageRange/
// maxDistanceKm) as the real deterministicFilter (docs/adr/0006), a user whose
// stated preferences are narrow can legitimately have fewer than 5 mutually
// compatible candidates in the seeded population. See issue #31.
export const ExpectedMatchesSchema = z.array(z.string().uuid()).max(5);

export type ExpectedMatches = z.infer<typeof ExpectedMatchesSchema>;

// Note: these fields are not yet on the Prisma User model (id, username,
// createdAt only — see packages/database/prisma/schema.prisma). They model
// the email-based registration flow from docs/PRODUCT_SPEC.md section 2,
// which has not replaced the username-based flow (schemas.ts, users.ts)
// yet — that migration is tracked separately on issue #11.
export const UserResponseSchema = UserFieldsSchema.omit({ phone: true }).extend({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
});

export type UserResponse = z.infer<typeof UserResponseSchema>;

// The real photo requested by Barney right after Phase 2 completes (#200,
// docs/adr/0016) — a base64 data URL, capped around 5MB of original image
// data (base64 inflates size by ~4/3, hence the higher character limit).
// Deliberately NOT part of UserResponseSchema — see that schema's note above
// on GET /api/users/:id having no ownership check.
const MAX_PHOTO_DATA_URL_LENGTH = 7_000_000;

export const PhotoUploadInputSchema = z.object({
  photoUrl: z
    .string()
    .regex(/^data:image\/(png|jpe?g|webp);base64,/, "Must be a JPG, PNG, or WEBP image")
    .max(MAX_PHOTO_DATA_URL_LENGTH, "Photo is too large — please use one under 5MB"),
});

export type PhotoUploadInput = z.infer<typeof PhotoUploadInputSchema>;

// Returned by GET /api/users/:id/match-photo — the current MATCHED partner's
// photo, revealed on the Pitch page right before the Yeah/Nah decision. Kept
// out of UserStateResponse deliberately: the photo is a multi-MB base64 data
// URL and /state is polled frequently, so only the Pitch page fetches it, and
// only when it is about to show it. photoUrl is null if the partner has none.
export const MatchPhotoResponseSchema = z.object({
  photoUrl: z.string().nullable(),
  // ADR-0022: the pitch now reveals the match's name + education on the
  // "Introducing…" card, so they ride along with the photo the pitch already
  // fetches. Both default to null (no current match, or the field is unknown)
  // so existing callers that pass only photoUrl still parse.
  partnerName: z.string().nullable().default(null),
  education: z.string().nullable().default(null),
});

export type MatchPhotoResponse = z.infer<typeof MatchPhotoResponseSchema>;
