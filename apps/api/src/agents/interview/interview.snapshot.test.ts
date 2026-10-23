import { describe, it, expect, vi } from "vitest";
import { EngineSnapshotSchema } from "@wingman/shared";
import { InterviewEngine } from "./interview.engine";
import type { SoftTurnFn, SoftTurnParams } from "./softTurn";

// The engine's snapshot/restore pair (#545): what makes an interview survive
// an api restart. The test double for the restart is deliberately literal —
// build a brand new engine, hand it the old one's snapshot, keep going.

vi.mock("./addendum", () => ({ routeAddendum: async () => ({ kind: "none" }) }));

function makePersist() {
  const calls: Record<string, unknown>[] = [];
  const persist = vi.fn(async (_userId: string, profile: Record<string, unknown>) => {
    calls.push(profile);
  });
  return { persist, calls };
}

// Judges every answer sufficient with schema-valid canned values, so a full
// interview runs to completion without Haiku or the DB — the same fake the
// engine's own suite uses.
function softAlwaysSufficient(): SoftTurnFn {
  const valid: Record<string, unknown> = {
    hobbies: [],
    personality_traits: [],
    social_energy: "ambivert",
    wants_kids: "undecided",
  };
  return async ({ node }: SoftTurnParams) => ({
    sufficient: true,
    extracted_value: Object.prototype.hasOwnProperty.call(valid, node.field)
      ? valid[node.field]
      : `value-${node.field}`,
    message: `ack-${node.field}`,
  });
}

function makeEngine(persist: ReturnType<typeof makePersist>["persist"]) {
  return new InterviewEngine("u1", {
    language: "en",
    runSoftTurn: softAlwaysSufficient(),
    persist,
  });
}

// Runs an engine to completion with generic answers, returning the last turn.
async function finish(engine: InterviewEngine) {
  let turn = await engine.handleMessage("a detailed enough answer");
  let guard = 0;
  while (!turn.phaseComplete && guard++ < 60) {
    turn = await engine.handleMessage("a detailed enough answer");
  }
  expect(turn.phaseComplete).toBe(true);
  return turn;
}

describe("InterviewEngine snapshot/restore — the restart survival contract", () => {
  it("resumes on a fresh engine with every prior answer intact", async () => {
    const { persist, calls } = makePersist();
    const before = makeEngine(persist);
    await before.handleMessage("start"); // greeting + age
    await before.handleMessage("30"); // age collected -> city
    const atCity = await before.handleMessage("Tel Aviv"); // city collected -> next

    // "The api restarted": a brand new engine, restored from the snapshot.
    const after = makeEngine(persist);
    after.restore(before.snapshot());

    // The restored engine is at the exact same turn — same question pending —
    // and finishing it persists the answers given before the restart.
    expect(after.snapshot()).toEqual(before.snapshot());
    const resumed = await after.handleMessage("a detailed enough answer");
    expect(resumed.question).not.toBe(atCity.question); // it moved on, not re-asked
    await finish(after);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(calls[0].age).toBe(30);
    expect(calls[0].city).toBe("Tel Aviv");
  });

  it("produces a snapshot that survives the JSON round-trip the DB imposes", async () => {
    const engine = makeEngine(makePersist().persist);
    await engine.handleMessage("start");
    await engine.handleMessage("30");

    const parsed = EngineSnapshotSchema.parse(JSON.parse(JSON.stringify(engine.snapshot())));
    const restored = makeEngine(makePersist().persist);
    restored.restore(parsed);

    expect(restored.snapshot()).toEqual(engine.snapshot());
  });

  it("freezes the snapshot at its turn — the live engine advancing cannot mutate it", async () => {
    const engine = makeEngine(makePersist().persist);
    await engine.handleMessage("start");
    await engine.handleMessage("30");
    const frozen = engine.snapshot();

    await engine.handleMessage("Tel Aviv"); // live engine collects city

    expect(frozen.collected).toEqual({ age: 30 });
    expect(frozen.transcript.length).toBeLessThan(engine.snapshot().transcript.length);
  });

  it("keeps 'go back' working across the restore — history survives", async () => {
    const before = makeEngine(makePersist().persist);
    const first = await before.handleMessage("start"); // presents the age question
    await before.handleMessage("30"); // -> city

    const after = makeEngine(makePersist().persist);
    after.restore(before.snapshot());

    // Going back from the restored city question lands on the age question —
    // the presented-node history came through the snapshot.
    const back = await after.handleMessage("go back");
    expect(back.question).toBe(first.question);
  });
});
