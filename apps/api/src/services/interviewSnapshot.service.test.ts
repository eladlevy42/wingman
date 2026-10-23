import "./barney.test-support";

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "@wingman/database";
import type { EngineSnapshot } from "@wingman/shared";
import {
  saveInterviewSnapshot,
  loadInterviewSnapshot,
  deleteInterviewSnapshot,
} from "./interviewSnapshot.service";

// The durable half of #545. Everything here runs against the mocked Prisma
// client from barney.test-support — what matters is the policy: what gets
// stored, what qualifies for rehydration, and that no storage failure can
// escalate past this service.

const NOW = 1_700_000_000_000;
const SESSION = "11111111-2222-4333-8444-555555555555";

const VALID_STATE: EngineSnapshot = {
  language: "he",
  started: true,
  done: false,
  currentIndex: 2,
  probesUsed: 1,
  history: [0, 1, 2],
  awaitingAddendum: false,
  wrapupOffered: false,
  collected: { age: 30, city: "תל אביב" },
  transcript: ["Barney: [redacted]", "User: 30"],
  factAckIndex: 2,
};

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SESSION,
    userId: "u-1",
    mode: "interview_self",
    state: JSON.stringify(VALID_STATE),
    updatedAt: new Date(NOW - 60_000),
    ...overrides,
  };
}

const mockFind = vi.mocked(prisma.interviewSessionSnapshot.findUnique);
const mockUpsert = vi.mocked(prisma.interviewSessionSnapshot.upsert);
const mockDelete = vi.mocked(prisma.interviewSessionSnapshot.deleteMany);

beforeEach(() => {
  vi.clearAllMocks();
  mockFind.mockResolvedValue(null as never);
  mockUpsert.mockResolvedValue(undefined as never);
  mockDelete.mockResolvedValue({ count: 0 } as never);
});

const LAST_TURN = {
  turnId: "turn-7",
  result: { reply: "Barney: [redacted]", phaseComplete: false },
};

describe("saveInterviewSnapshot", () => {
  it("upserts the session's state and last turn as JSON", async () => {
    await saveInterviewSnapshot(SESSION, "u-1", "interview_self", VALID_STATE, LAST_TURN);

    expect(mockUpsert).toHaveBeenCalledWith({
      where: { id: SESSION },
      create: {
        id: SESSION,
        userId: "u-1",
        mode: "interview_self",
        state: JSON.stringify(VALID_STATE),
        lastTurn: JSON.stringify(LAST_TURN),
      },
      update: { state: JSON.stringify(VALID_STATE), lastTurn: JSON.stringify(LAST_TURN) },
    });
  });

  it("stores a null last turn for a turn the client sent no turnId for", async () => {
    await saveInterviewSnapshot(SESSION, "u-1", "interview_self", VALID_STATE, null);

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { state: JSON.stringify(VALID_STATE), lastTurn: null } })
    );
  });

  it("swallows a storage failure — the turn already succeeded", async () => {
    mockUpsert.mockRejectedValue(new Error("db down"));
    await expect(
      saveInterviewSnapshot(SESSION, "u-1", "interview_self", VALID_STATE, null)
    ).resolves.toBeUndefined();
  });
});

describe("loadInterviewSnapshot", () => {
  it("returns the parsed snapshot for a live row", async () => {
    mockFind.mockResolvedValue(row({ lastTurn: JSON.stringify(LAST_TURN) }) as never);

    const stored = await loadInterviewSnapshot(SESSION, NOW);

    expect(stored).toEqual({
      userId: "u-1",
      mode: "interview_self",
      state: VALID_STATE,
      lastTurn: LAST_TURN,
    });
    expect(mockDelete).not.toHaveBeenCalled();
  });

  // A lastTurn this build can't read only costs the replay dedup for one
  // retried turn — never the whole rehydratable interview.
  it("drops only the last turn when it is unreadable, keeping the snapshot", async () => {
    mockFind.mockResolvedValue(row({ lastTurn: "{not json" }) as never);

    const stored = await loadInterviewSnapshot(SESSION, NOW);

    expect(stored?.state).toEqual(VALID_STATE);
    expect(stored?.lastTurn).toBeUndefined();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it("returns null when there is no row", async () => {
    expect(await loadInterviewSnapshot(SESSION, NOW)).toBeNull();
  });

  // Restarting the api must never extend a session's life beyond what staying
  // up would have — the snapshot honours the same TTL the registry sweeps by.
  it("drops a snapshot idle past the session TTL", async () => {
    mockFind.mockResolvedValue(row({ updatedAt: new Date(NOW - 121 * 60_000) }) as never);

    expect(await loadInterviewSnapshot(SESSION, NOW)).toBeNull();
    expect(mockDelete).toHaveBeenCalled();
  });

  // The acceptance criterion: a finished interview must never rehydrate. The
  // completion path deletes the row, so this guards the crash window between
  // finalize() persisting the profile and the delete landing.
  it("refuses to resurrect a finished interview", async () => {
    mockFind.mockResolvedValue(
      row({ state: JSON.stringify({ ...VALID_STATE, done: true }) }) as never
    );

    expect(await loadInterviewSnapshot(SESSION, NOW)).toBeNull();
    expect(mockDelete).toHaveBeenCalled();
  });

  // A snapshot can outlive the deploy that wrote it; anything this build can't
  // parse is dead data, not an error.
  it.each([
    ["corrupt JSON", row({ state: "{not json" })],
    ["schema-invalid state", row({ state: JSON.stringify({ language: "he" }) })],
    ["unknown mode", row({ mode: "pitch" })],
  ])("drops a row it cannot rehydrate: %s", async (_label, stored) => {
    mockFind.mockResolvedValue(stored as never);

    expect(await loadInterviewSnapshot(SESSION, NOW)).toBeNull();
    expect(mockDelete).toHaveBeenCalled();
  });

  it("degrades a read failure to 'not found' rather than throwing", async () => {
    mockFind.mockRejectedValue(new Error("db down"));
    expect(await loadInterviewSnapshot(SESSION, NOW)).toBeNull();
  });
});

describe("deleteInterviewSnapshot", () => {
  it("deletes by session id and swallows failures", async () => {
    await deleteInterviewSnapshot(SESSION);
    expect(mockDelete).toHaveBeenCalledWith({ where: { id: SESSION } });

    mockDelete.mockRejectedValue(new Error("db down"));
    await expect(deleteInterviewSnapshot(SESSION)).resolves.toBeUndefined();
  });
});
