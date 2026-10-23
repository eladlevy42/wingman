import { z } from "zod";
import { InterviewLanguageSchema } from "../i18n";

// The four phases Barney operates in. Fixed once per session at construction —
// no session ever switches mode mid-conversation. See docs/PRODUCT_SPEC.md
// section 3 and CONTEXT.md "Mode switching".
export const BarneyModeSchema = z.enum(["interview_self", "interview_wants", "pitch", "debrief"]);

export type BarneyMode = z.infer<typeof BarneyModeSchema>;

// POST /api/barney/session — starts a conversation in the given mode.
// matchId is required for "pitch" (docs/adr/0014) and "debrief" (#75) — both
// need to look up a specific Match. interview_self/interview_wants never take
// one: they operate on the calling user alone.
const MODES_REQUIRING_MATCH_ID = new Set<z.infer<typeof BarneyModeSchema>>(["pitch", "debrief"]);

export const BarneySessionInputSchema = z
  .object({
    userId: z.string().min(1),
    mode: BarneyModeSchema,
    matchId: z.string().min(1).optional(),
    // The language the interview is conducted in (ADR-0037). Optional on the
    // wire so an older client still works; the service defaults it to Hebrew.
    language: InterviewLanguageSchema.optional(),
  })
  .refine((input) => !MODES_REQUIRING_MATCH_ID.has(input.mode) || input.matchId !== undefined, {
    message: 'matchId is required when mode is "pitch" or "debrief"',
    path: ["matchId"],
  });

export type BarneySessionInput = z.infer<typeof BarneySessionInputSchema>;

export const BarneySessionResponseSchema = z.object({
  sessionId: z.string().uuid(),
});

export type BarneySessionResponse = z.infer<typeof BarneySessionResponseSchema>;

// Generous enough for any real conversational turn while keeping a single
// message from blowing up LLM context/token cost or DB storage (#227).
// Exported so schemas.ts's legacy ChatMessageSchema/SendMessageSchema can
// share this bound instead of redefining it.
export const MAX_MESSAGE_LENGTH = 4000;

// Where a composer starts showing a live character count. The cap is enforced
// on the input itself, so without a counter the field simply stops accepting
// characters with nothing on screen to explain why — and a pasted answer is
// silently truncated. Shared rather than per-client so the two composers cannot
// drift on when the warning appears (#493).
export const MESSAGE_LENGTH_COUNTER_FROM = MAX_MESSAGE_LENGTH - 200;

// POST /api/barney/message — exchanges one turn within an existing session.
// turnId is an optional client-generated nonce (e.g. crypto.randomUUID()) that
// stays the same across a streamed attempt and its non-streaming fallback retry
// (see streamBarneyMessage.ts / BarneyPhase1.tsx). It lets the server recognize
// a retry of the same turn and return the cached result instead of re-running
// it against the stateful InterviewEngine / BarneyAgent — see barney.service.ts.
export const BarneyMessageInputSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1).max(MAX_MESSAGE_LENGTH),
  turnId: z.string().min(1).optional(),
  // The language this turn should be conducted in (ADR-0037). Sent on every
  // turn rather than only at session creation so the flag toggle takes effect
  // mid-interview, and so a session resumed from client storage re-asserts the
  // user's saved choice instead of silently reverting to the default.
  language: InterviewLanguageSchema.optional(),
});

export type BarneyMessageInput = z.infer<typeof BarneyMessageInputSchema>;

// The section (topic bucket) the current interview question belongs to, so the
// UI can show a title + "Section 2 of 5". Only the deterministic InterviewEngine
// (Phase 1 / Phase 2) populates this; the free-form pitch/debrief modes leave it
// undefined. `index` is 1-based.
export const InterviewSectionSchema = z.object({
  title: z.string(),
  index: z.number().int().positive(),
  total: z.number().int().positive(),
});

export type InterviewSection = z.infer<typeof InterviewSectionSchema>;

// How far through the interview the user is, for a progress bar. `answered`
// counts fields collected so far; on completion it equals `total`.
export const InterviewProgressSchema = z.object({
  answered: z.number().int().nonnegative(),
  total: z.number().int().positive(),
});

export type InterviewProgress = z.infer<typeof InterviewProgressSchema>;

// One selectable option for a "choice" input (label shown, value sent back).
export const InputChoiceSchema = z.object({
  label: z.string(),
  value: z.string(),
});

// Tells the client how to render the input control for the current question.
// "text" is the free-text default (deep questions); "age" is an 18+ numeric
// picker; "height" is a scrolling picker of heights (in cm, labelled with the
// imperial equivalent) so the value can never be off-topic free text; "choice"
// is a small set of tappable options (e.g. Yes/No/Undecided), with allowFreeText
// letting the user type instead when they want to elaborate.
//
// "multiChoice" is "choice" for questions whose answer is a *list* rather than
// one pick: the user toggles any number of options and confirms once, so the
// engine receives a clean comma-joined list instead of prose it has to mine.
// It exists because free-text hobbies were being extracted into a malformed
// shape and silently dropped (#529). allowFreeText here means "and anything not
// on this list, in your own words" — the composer text is merged into the
// selection rather than replacing it, which is why it is a separate kind and
// not a flag on "choice".
export const InputDescriptorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text") }),
  z.object({
    kind: z.literal("age"),
    min: z.number().int().positive(),
    max: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("height"),
    minCm: z.number().int().positive(),
    maxCm: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("choice"),
    options: z.array(InputChoiceSchema).min(1),
    allowFreeText: z.boolean(),
  }),
  z.object({
    kind: z.literal("multiChoice"),
    options: z.array(InputChoiceSchema).min(1),
    allowFreeText: z.boolean(),
    // Label for the button that submits the current selection. Server-supplied
    // so the copy stays with the question it confirms rather than being frozen
    // into two separate client components.
    confirmLabel: z.string().min(1),
  }),
]);

export type InputDescriptor = z.infer<typeof InputDescriptorSchema>;

// phaseComplete is true only on the turn where the mode's completion tool
// (saveProfile in Phase 1) fired — the client uses it to advance to the next
// phase. See docs/PRODUCT_SPEC.md section 3.
//
// The interview-only fields below (acknowledgement/question/section/progress/
// input) are populated by the deterministic InterviewEngine to drive the richer
// Phase 1/2 chat UI (split ack + question bubbles, progress bar, section title,
// interactive inputs). They are optional so the free-form pitch/debrief modes,
// which only ever set { reply, phaseComplete }, still satisfy this schema.
// `reply` remains the ack + question joined for any client not consuming the
// split fields.
export const BarneyMessageResponseSchema = z.object({
  reply: z.string(),
  phaseComplete: z.boolean(),
  acknowledgement: z.string().nullable().optional(),
  question: z.string().nullable().optional(),
  section: InterviewSectionSchema.nullable().optional(),
  progress: InterviewProgressSchema.optional(),
  input: InputDescriptorSchema.optional(),
});

export type BarneyMessageResponse = z.infer<typeof BarneyMessageResponseSchema>;

// POST /api/barney/language — the mid-interview language toggle (ADR-0037).
// Every turn already carries the language, which switches Barney's *next*
// reply; this endpoint exists for the question already on screen, so the user
// is not left reading it (and tapping its answer chips) in the language they
// just switched away from.
export const BarneyLanguageInputSchema = z.object({
  sessionId: z.string().min(1),
  language: InterviewLanguageSchema,
});

export type BarneyLanguageInput = z.infer<typeof BarneyLanguageInputSchema>;

// `turn` is the pending question restated in the new language, shaped like any
// other engine turn so the client applies its section/progress/input the same
// way. Null when there is nothing to restate: the language did not change, the
// session is not an interview, or a turn is still in flight.
export const BarneyLanguageResponseSchema = z.object({
  turn: BarneyMessageResponseSchema.nullable(),
});

export type BarneyLanguageResponse = z.infer<typeof BarneyLanguageResponseSchema>;

// Server-sent events for POST /api/barney/message/stream — the streaming
// counterpart of /message. The server runs the same engine turn, then streams
// the computed reply so the client can render it word-by-word:
//   bubble_start → many delta → (next bubble_start → delta …) → done
// A `bubble_start` opens a new assistant bubble; each `delta` appends text to
// it; `done` carries the same section/progress/input metadata /message returns;
// `error` reports a mid-stream failure. Everything crossing the wire is parsed
// against this schema on the client.
export const BarneyStreamBubbleSchema = z.enum(["acknowledgement", "question"]);

export const BarneyStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bubble_start"), bubble: BarneyStreamBubbleSchema }),
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({
    type: z.literal("done"),
    phaseComplete: z.boolean(),
    section: InterviewSectionSchema.nullable().optional(),
    progress: InterviewProgressSchema.optional(),
    input: InputDescriptorSchema.optional(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export type BarneyStreamEvent = z.infer<typeof BarneyStreamEventSchema>;
