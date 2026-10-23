import AsyncStorage from "@react-native-async-storage/async-storage";
import { StoredBarneySessionSchema, type StoredBarneySession } from "@wingman/shared";

export type { StoredBarneySession };

// Kept separate from SESSION_KEY (the stored user) rather than nested inside it:
// the two have completely different lifetimes. The user survives until sign-out;
// a conversation is discarded the moment its phase completes.
export const BARNEY_SESSION_KEY = "barneySession";

/**
 * How long a stored conversation is worth trying to resume.
 *
 * This mirrors the api's own default idle TTL (BARNEY_SESSION_TTL_MINUTES,
 * default 120 — see apps/api/src/services/barney.sessionRegistry.ts) and is
 * deliberately only a heuristic: the server is the authority, and it can be
 * configured differently or simply restart, which drops every in-memory session
 * regardless of TTL. All this does is spare the user the worse of the two
 * failure modes — being shown a fully restored interview that turns out to be
 * dead the moment they answer. A snapshot the server has already forgotten is
 * still caught, by the "session not found" the next turn returns.
 */
export const RESUMABLE_FOR_MS = 120 * 60_000;

/**
 * Parses a stored snapshot, or null if it is missing, corrupt, no longer
 * matches the schema, or is too old to be worth resuming.
 *
 * Pure and exported so "a bad stored value starts a fresh interview rather than
 * crashing you" is testable without a device — the same shape as
 * parseStoredUser in session.ts.
 */
export function parseStoredBarneySession(
  raw: string | null,
  now: number
): StoredBarneySession | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = StoredBarneySessionSchema.safeParse(value);
  if (!parsed.success) return null;
  // A clock that has moved backwards (timezone change, NTP correction) would
  // make savedAt look like the future. Treat that as "recent" rather than
  // "expired": the server's own 404 is the real check either way.
  if (now - parsed.data.savedAt > RESUMABLE_FOR_MS) return null;
  return parsed.data;
}

/** True when the snapshot belongs to the conversation about to be opened. */
export function matchesConversation(
  stored: StoredBarneySession,
  target: { userId: string; mode: StoredBarneySession["mode"]; matchId?: string }
): boolean {
  return (
    stored.userId === target.userId &&
    stored.mode === target.mode &&
    stored.matchId === target.matchId
  );
}

export async function saveBarneySession(snapshot: StoredBarneySession): Promise<void> {
  // Best-effort throughout. Persistence is a convenience layered on a
  // conversation that is already working; a storage failure must never take the
  // live interview down with it.
  try {
    await AsyncStorage.setItem(BARNEY_SESSION_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignored — see above.
  }
}

export async function loadBarneySession(now: number): Promise<StoredBarneySession | null> {
  try {
    return parseStoredBarneySession(await AsyncStorage.getItem(BARNEY_SESSION_KEY), now);
  } catch {
    return null;
  }
}

export async function clearBarneySession(): Promise<void> {
  try {
    await AsyncStorage.removeItem(BARNEY_SESSION_KEY);
  } catch {
    // Ignored — see saveBarneySession.
  }
}
