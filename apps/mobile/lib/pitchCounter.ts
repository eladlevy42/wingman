import AsyncStorage from "@react-native-async-storage/async-storage";
import { StoredPitchCounterSchema } from "@wingman/shared";

/**
 * The Genie Mechanic's question allowance (ADR-0013, CONTEXT.md "Genie
 * Mechanic"): the user may ask Barney exactly three questions about their match
 * before the Yeah/Nah decision.
 *
 * Enforced entirely here and by the composer this gates — never by
 * `PITCH_PROMPT`. Barney is not told to count questions or cut himself off, so
 * if the UI stops counting, nothing else will.
 */
export const TOTAL_QUESTIONS = 3;

/** How many questions the user has left, given how many have landed. */
export function questionsLeft(asked: number): number {
  return Math.max(0, TOTAL_QUESTIONS - asked);
}

/**
 * Whether the composer should accept another question.
 *
 * `busy` is the turn-in-flight flag, not the typing indicator. useBarneyChat
 * refuses a send while a turn is still revealing and gates on the same flag, so
 * this agrees with it rather than racing it — a double-tap during a reply
 * cannot burn two questions.
 */
export function canAsk(asked: number, busy: boolean): boolean {
  return questionsLeft(asked) > 0 && !busy;
}

/**
 * The allowance after a turn resolves.
 *
 * Only a turn that actually landed costs a question. A failed one must not:
 * useBarneyChat leaves the user's message in the transcript when the turn
 * throws (it appends an error bubble beneath it rather than rewinding), so
 * counting sent messages would charge the user for the api being unreachable.
 * Its `send` resolves false in exactly that case, which is what `succeeded`
 * carries here.
 *
 * Clamped at the total so a stray extra success cannot push the count past the
 * allowance and make `questionsLeft` misreport.
 */
export function afterTurn(asked: number, succeeded: boolean): number {
  return succeeded ? Math.min(TOTAL_QUESTIONS, asked + 1) : asked;
}

/**
 * Where the spent count is kept between mounts.
 *
 * The allowance has to outlive the screen, because the conversation does.
 * `useBarneyChat` resumes a pitch from storage with its transcript intact, so a
 * count held only in component state came back as zero against a transcript
 * that already had three questions in it — the reload handed the user a second
 * allowance, and the composer reopened. Nothing else would have caught it:
 * `PITCH_PROMPT` never tells Barney there is a limit (ADR-0013).
 */
export const PITCH_COUNTER_KEY = "pitchCounter";

/**
 * Reads the count belonging to `sessionId`, or 0 when there is none to read.
 *
 * Pure and exported separately from the storage call so the cases that matter —
 * a record from a different conversation, a corrupt value, a hand-edited
 * negative — are testable without a device, in the same shape as
 * `parseStoredBarneySession`.
 *
 * Every one of those cases answers 0 rather than throwing: a stored counter is
 * a defence against a reload, not against a hostile client, and refusing to
 * open the pitch because a cache entry is malformed would be the worse failure.
 * The ceiling is the important half — `Math.min` means a tampered or stale
 * record cannot report *more* than the allowance and make `questionsLeft`
 * misreport a negative.
 */
export function parseStoredPitchCounter(raw: string | null, sessionId: string): number {
  if (raw === null) return 0;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return 0;
  }
  const parsed = StoredPitchCounterSchema.safeParse(value);
  if (!parsed.success) return 0;
  if (parsed.data.sessionId !== sessionId) return 0;
  return Math.min(TOTAL_QUESTIONS, parsed.data.asked);
}

/** The count spent in `sessionId` so far. Best-effort: a read failure is 0. */
export async function loadPitchCounter(sessionId: string): Promise<number> {
  try {
    return parseStoredPitchCounter(await AsyncStorage.getItem(PITCH_COUNTER_KEY), sessionId);
  } catch {
    return 0;
  }
}

/**
 * Records the count against `sessionId`.
 *
 * Best-effort, like `saveBarneySession`: a storage failure must not take the
 * live pitch down. It does mean a device that cannot write loses the count on
 * reload — the same reload that would already have lost the transcript, so the
 * user is starting over rather than sneaking a fourth question into a
 * conversation that still shows the first three.
 */
export async function savePitchCounter(sessionId: string, asked: number): Promise<void> {
  try {
    await AsyncStorage.setItem(PITCH_COUNTER_KEY, JSON.stringify({ sessionId, asked }));
  } catch {
    // Ignored — see above.
  }
}
