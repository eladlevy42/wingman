import { z } from "zod";
import { InterviewLanguageSchema } from "../i18n";
import { BarneyMessageResponseSchema } from "./barney";

// The InterviewEngine's full resumable state (#545) — everything mutable the
// engine holds between turns, snapshotted to the database after each turn so
// an api restart can rehydrate an in-progress interview instead of silently
// restarting it. The tree/config are deterministic from the session's mode, so
// they are not part of the snapshot.
//
// Lives in packages/shared (rather than apps/api) per the repo rule that every
// Zod schema does, even though only the api reads and writes it: the stored
// JSON outlives api deploys, which makes this a data contract, not an
// implementation detail.
export const EngineSnapshotSchema = z.object({
  language: InterviewLanguageSchema,
  started: z.boolean(),
  done: z.boolean(),
  currentIndex: z.number().int(),
  probesUsed: z.number().int(),
  // The distinct question nodes presented so far, as tree indices — powers
  // "go back" after a resume exactly as before the restart.
  history: z.array(z.number().int()),
  awaitingAddendum: z.boolean(),
  wrapupOffered: z.boolean(),
  // The answer bag, keyed by node.field — the state the user cannot afford to
  // lose.
  collected: z.record(z.unknown()),
  transcript: z.array(z.string()),
  factAckIndex: z.number().int(),
});

export type EngineSnapshot = z.infer<typeof EngineSnapshotSchema>;

// The session's last completed turn, snapshotted alongside the engine state.
// This is what makes the client's turnId-replay dedup survive a restart: the
// stream-drop fallback can retry a turn the api answered moments before dying,
// and without this the retried text would run as the answer to the NEXT
// question on the rehydrated engine — silently double-advancing the interview.
export const SnapshotLastTurnSchema = z.object({
  turnId: z.string(),
  result: BarneyMessageResponseSchema,
});

export type SnapshotLastTurn = z.infer<typeof SnapshotLastTurnSchema>;
