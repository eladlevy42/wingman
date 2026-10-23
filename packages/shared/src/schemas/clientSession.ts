import { z } from "zod";
import { ChatMessageSchema } from "../schemas";
import {
  BarneyModeSchema,
  InputDescriptorSchema,
  InterviewProgressSchema,
  InterviewSectionSchema,
} from "./barney";

/**
 * A Phase 1/2 conversation as the client last rendered it, persisted so a
 * reload does not discard the user's answers (#496).
 *
 * This is client-local persistence rather than an API boundary — no route
 * accepts or returns it. It lives here anyway because CLAUDE.md §3/§12 say
 * every Zod schema in `mobile`/`web`/`api` is imported from `packages/shared`,
 * and a single client-local exception is how that rule stops being a rule. It
 * also composes entirely from the Barney schemas next door, so keeping it here
 * means a change to `InputDescriptorSchema` cannot silently desync from the
 * snapshot that stores one.
 *
 * The transcript is stored because it is the client's alone: the api holds the
 * InterviewEngine's state (collected answers, current question, probe budget)
 * but has no endpoint that hands back the conversation as it was rendered.
 */
export const StoredBarneySessionSchema = z.object({
  sessionId: z.string().uuid(),
  // Scoped so a snapshot can never be replayed into the wrong conversation:
  // a different user (a sign-out and sign-in on a shared device), or the same
  // user's later phase.
  userId: z.string().min(1),
  mode: BarneyModeSchema,
  matchId: z.string().min(1).optional(),
  savedAt: z.number(),
  messages: z.array(ChatMessageSchema),
  // The UI state the last `done` event carried. Without these the resumed
  // screen would show the transcript but no progress bar, no section title, and
  // a plain text box where the question wants an age or height picker.
  section: InterviewSectionSchema.nullable(),
  progress: InterviewProgressSchema.optional(),
  input: InputDescriptorSchema.optional(),
});

export type StoredBarneySession = z.infer<typeof StoredBarneySessionSchema>;

/**
 * The Genie Mechanic's spent-question count, persisted so a reload cannot hand
 * the user a fresh allowance (#463).
 *
 * Client-local persistence like `StoredBarneySession` above, and here for the
 * same reason — CLAUDE.md §3/§12 keep every Zod schema in `packages/shared`.
 *
 * Scoped by `sessionId` rather than by match or user, which is what gives the
 * count the same lifetime as the conversation it belongs to. Resuming keeps the
 * session id and so keeps the count; a session the api has forgotten is
 * replaced by a fresh one with a new id, and this record stops matching — which
 * is the wanted behaviour, because that user is starting the pitch over with an
 * empty transcript and nothing left to remember.
 */
export const StoredPitchCounterSchema = z.object({
  sessionId: z.string().uuid(),
  asked: z.number().int().min(0),
});

export type StoredPitchCounter = z.infer<typeof StoredPitchCounterSchema>;
