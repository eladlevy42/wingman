import { beforeEach, describe, expect, it } from "vitest";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  BARNEY_SESSION_KEY,
  RESUMABLE_FOR_MS,
  clearBarneySession,
  loadBarneySession,
  matchesConversation,
  parseStoredBarneySession,
  saveBarneySession,
  type StoredBarneySession,
} from "./barneySession";

const NOW = 1_700_000_000_000;
const SESSION_ID = "11111111-1111-1111-1111-111111111111";

function snapshot(overrides: Partial<StoredBarneySession> = {}): StoredBarneySession {
  return {
    sessionId: SESSION_ID,
    userId: "user-1",
    mode: "interview_self",
    savedAt: NOW,
    messages: [
      { role: "assistant", content: "How old are you?" },
      { role: "user", content: "29" },
      { role: "assistant", content: "Which city do you live in?" },
    ],
    section: { title: "The basics", index: 1, total: 5 },
    progress: { answered: 1, total: 18 },
    input: { kind: "text" },
    ...overrides,
  };
}

beforeEach(async () => {
  (AsyncStorage as unknown as { __reset: () => void }).__reset();
});

describe("parseStoredBarneySession", () => {
  it("round-trips a saved conversation", async () => {
    const saved = snapshot();
    await saveBarneySession(saved);

    expect(await loadBarneySession(NOW)).toEqual(saved);
  });

  it("returns null when nothing was ever saved", () => {
    expect(parseStoredBarneySession(null, NOW)).toBeNull();
  });

  it("returns null for a corrupt value rather than throwing", () => {
    expect(parseStoredBarneySession("{not json", NOW)).toBeNull();
  });

  it("returns null when the stored shape no longer matches the schema", () => {
    // e.g. a snapshot written before `progress` existed, or by a future version.
    const stale = JSON.stringify({ sessionId: SESSION_ID, userId: "user-1" });
    expect(parseStoredBarneySession(stale, NOW)).toBeNull();
  });

  it("returns null for a message that is not a valid ChatMessage", () => {
    const bad = JSON.stringify(
      snapshot({ messages: [{ role: "barney", content: "hi" }] as never })
    );
    expect(parseStoredBarneySession(bad, NOW)).toBeNull();
  });

  // The api keeps a session alive for its idle TTL; past that, restoring the
  // transcript would show the user a full interview that dies on their next
  // answer. Better to start fresh than to promise a resume that cannot happen.
  it("keeps a snapshot saved within the resumable window", () => {
    const raw = JSON.stringify(snapshot({ savedAt: NOW - RESUMABLE_FOR_MS + 1_000 }));
    expect(parseStoredBarneySession(raw, NOW)).not.toBeNull();
  });

  it("drops a snapshot older than the resumable window", () => {
    const raw = JSON.stringify(snapshot({ savedAt: NOW - RESUMABLE_FOR_MS - 1 }));
    expect(parseStoredBarneySession(raw, NOW)).toBeNull();
  });

  it("treats a savedAt in the future as recent, not expired", () => {
    // A clock correction or timezone change can move `now` backwards. The
    // server's own 404 is the real authority, so err towards trying.
    const raw = JSON.stringify(snapshot({ savedAt: NOW + 60_000 }));
    expect(parseStoredBarneySession(raw, NOW)).not.toBeNull();
  });
});

describe("matchesConversation", () => {
  it("matches the conversation it was saved for", () => {
    expect(matchesConversation(snapshot(), { userId: "user-1", mode: "interview_self" })).toBe(
      true
    );
  });

  it("does not match a different user", () => {
    expect(matchesConversation(snapshot(), { userId: "user-2", mode: "interview_self" })).toBe(
      false
    );
  });

  it("does not match a different phase", () => {
    expect(matchesConversation(snapshot(), { userId: "user-1", mode: "interview_wants" })).toBe(
      false
    );
  });

  it("does not match when only one side carries a matchId", () => {
    expect(
      matchesConversation(snapshot({ mode: "pitch", matchId: "match-1" }), {
        userId: "user-1",
        mode: "pitch",
      })
    ).toBe(false);
  });

  it("matches when both carry the same matchId", () => {
    expect(
      matchesConversation(snapshot({ mode: "pitch", matchId: "match-1" }), {
        userId: "user-1",
        mode: "pitch",
        matchId: "match-1",
      })
    ).toBe(true);
  });
});

describe("clearBarneySession", () => {
  it("removes the snapshot so the next launch starts a new interview", async () => {
    await saveBarneySession(snapshot());
    await clearBarneySession();

    expect(await loadBarneySession(NOW)).toBeNull();
    expect(await AsyncStorage.getItem(BARNEY_SESSION_KEY)).toBeNull();
  });

  it("is safe to call when nothing was saved", async () => {
    await expect(clearBarneySession()).resolves.toBeUndefined();
  });
});

/**
 * RESUMABLE_FOR_MS mirrors the api's DEFAULT_TTL_MINUTES, and nothing in the
 * type system connects the two — the api is a separate process reached over
 * HTTP. This reads the api's source and fails if that default moves, which is
 * the only cheap way to notice that the client has started offering resumes the
 * server will refuse.
 *
 * Note this pins the *default* only. A deployment that sets
 * BARNEY_SESSION_TTL_MINUTES lower is still free to make the client optimistic;
 * that case is caught at runtime by the "Session not found" recovery, not here.
 */
describe("RESUMABLE_FOR_MS tracks the api's session TTL default", () => {
  it("matches DEFAULT_TTL_MINUTES in barney.sessionRegistry.ts", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const here = path.dirname(fileURLToPath(import.meta.url));
    const registry = readFileSync(
      path.resolve(here, "../../../apps/api/src/services/barney.sessionRegistry.ts"),
      "utf8"
    );

    const match = registry.match(/const DEFAULT_TTL_MINUTES = (\d+);/);
    expect(match, "DEFAULT_TTL_MINUTES not found — did the api rename it?").not.toBeNull();
    expect(Number(match![1]) * 60_000).toBe(RESUMABLE_FOR_MS);
  });
});
