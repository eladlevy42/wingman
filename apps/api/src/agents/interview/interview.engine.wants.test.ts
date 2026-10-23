import { describe, it, expect, vi } from "vitest";
import { WantedProfileSchema } from "@wingman/shared";
import { InterviewEngine } from "./interview.engine";
import { t } from "./localized";
import { INTERVIEW_WANTS_TREE } from "./wantsTree";
import type { SoftTurnFn, SoftTurnParams } from "./softTurn";

// Default the end-of-interview "anything else?" router (#251) to "nothing to
// add", so each walk finalizes after one extra decline turn. See the self-test
// for the addendum-routing coverage.
vi.mock("./addendum", () => ({
  routeAddendum: async () => ({ kind: "none" }),
}));

// End-to-end walk of the Phase-2 (interview_wants) tree through the shared
// engine, driven by config selection (mode: "interview_wants"). Confirms the
// engine assembles + persists a valid WantedProfile with the nested ageRange and
// the distance default — i.e. the config bundle carries the wants shape with no
// engine-core changes.

function makePersist() {
  const calls: Record<string, unknown>[] = [];
  const persist = vi.fn(async (_userId: string, profile: Record<string, unknown>) => {
    calls.push(profile);
  });
  return { persist, calls };
}

// Soft-turn fake: always sufficient, returns a per-field canned value. Fact nodes
// (ageMin/ageMax/maxDistanceKm) never reach the model — they parse the message.
function softWants(values: Record<string, unknown>): SoftTurnFn {
  const emptyArrayFields = new Set([
    "appearance",
    "personality",
    "lifestyle",
    "dealbreakers",
    "preferences",
    "compromises",
  ]);
  return async ({ node }: SoftTurnParams) => ({
    sufficient: true,
    extracted_value: Object.prototype.hasOwnProperty.call(values, node.field)
      ? values[node.field]
      : emptyArrayFields.has(node.field)
        ? []
        : "both",
    message: `ack-${node.field}`,
  });
}

// Feeds the greeting turn then each scripted answer until completion. Once the
// tree is covered the engine offers the #251 wrap-up recap (phaseComplete still
// false); decline it so the interview finalizes.
async function drive(engine: InterviewEngine, answers: string[]) {
  await engine.handleMessage("start"); // greeting + first question
  let last = { reply: "", phaseComplete: false };
  for (const a of answers) {
    last = await engine.handleMessage(a);
    if (last.phaseComplete) break;
  }
  if (!last.phaseComplete) {
    last = await engine.handleMessage("no, that's everything"); // decline the wrap-up
  }
  return last;
}

describe("InterviewEngine — interview_wants walk", () => {
  it("assembles and persists a valid WantedProfile with a nested ageRange", async () => {
    const { persist, calls } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      mode: "interview_wants",
      runSoftTurn: softWants({
        genderPreference: "female",
        appearance: ["tall"],
        personality: ["funny", "ambitious"],
        lifestyle: ["active"],
        dealbreakers: ["smoking"],
        preferences: ["shares a hobby"],
        compromises: ["would date a smoker if otherwise great"],
      }),
      persist,
    });

    // Node order: gender, ageMin, ageMax, maxDistanceKm, then the six soft lists.
    const answers = [
      "women", // genderPreference (soft)
      "25", // ageMin (fact)
      "40", // ageMax (fact)
      "50 km", // maxDistanceKm (fact)
      "tall", // appearance
      "funny", // personality
      "active", // lifestyle
      "smoking", // dealbreakers
      "hobby", // preferences
      "would bend on distance", // compromises
    ];

    const last = await drive(engine, answers);

    expect(last.phaseComplete).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);

    const saved = calls[0];
    expect(saved.genderPreference).toBe("female");
    expect(saved.ageRange).toEqual({ min: 25, max: 40 });
    expect(saved.maxDistanceKm).toBe(50);
    expect(saved.personality).toEqual(["funny", "ambitious"]);
    // The persisted object is a valid WantedProfile.
    expect(WantedProfileSchema.safeParse(saved).success).toBe(true);
  });

  it("records the 100km default when the user gives no distance number", async () => {
    const { persist, calls } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      mode: "interview_wants",
      runSoftTurn: softWants({ genderPreference: "both" }),
      persist,
    });

    // maxDistanceKm gets three non-numeric answers: two probes then a
    // force-advance to null, which assemble() turns into the 100km default.
    const answers = [
      "anyone", // genderPreference
      "25", // ageMin
      "40", // ageMax
      "same city", // maxDistanceKm — probe 1
      "not sure", // maxDistanceKm — probe 2
      "whatever", // maxDistanceKm — force-advance -> null -> default
      "no preference", // appearance
      "kind", // personality
      "chill", // lifestyle
      "none", // dealbreakers
      "none", // preferences
      "none", // compromises
    ];

    const last = await drive(engine, answers);

    expect(last.phaseComplete).toBe(true);
    expect(calls[0].maxDistanceKm).toBe(100);
  });

  it("re-asks only the offending field on a min>max ageRange, without re-asking already-answered fields", async () => {
    const { persist, calls } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      mode: "interview_wants",
      runSoftTurn: softWants({
        genderPreference: "female",
        appearance: ["tall"],
        personality: ["funny"],
        lifestyle: ["active"],
        dealbreakers: ["smoking"],
        preferences: ["shares a hobby"],
        compromises: ["would bend on distance"],
      }),
      persist,
    });

    await engine.handleMessage("start"); // greeting + genderPreference
    await engine.handleMessage("women"); // -> ageMin
    await engine.handleMessage("40"); // ageMin -> ageMax
    const invalid = await engine.handleMessage("25"); // ageMax=25 < ageMin=40, still not finalize yet

    await engine.handleMessage("50 km"); // maxDistanceKm
    await engine.handleMessage("tall"); // appearance
    await engine.handleMessage("funny"); // personality
    await engine.handleMessage("active"); // lifestyle
    await engine.handleMessage("smoking"); // dealbreakers
    await engine.handleMessage("hobby"); // preferences
    const wrapup = await engine.handleMessage("would bend on distance"); // compromises -> wrap-up recap
    const reask = await engine.handleMessage("no, that's everything"); // decline -> finalize fails

    expect(invalid.phaseComplete).toBe(false);
    // The tree is covered, so the wrap-up recap comes before finalize runs.
    expect(wrapup.phaseComplete).toBe(false);
    expect(wrapup.reply).toContain("[redacted:wrapup");
    // Declining triggers finalize(), which failed the min<=max refine and
    // re-asked the ageMax node only — the recap is not repeated afterwards.
    expect(reask.phaseComplete).toBe(false);
    const ageMax = INTERVIEW_WANTS_TREE.find((n) => n.field === "ageMax");
    expect(ageMax).toBeDefined();
    expect(reask.reply).toContain(t(ageMax!.text, "en"));
    expect(persist).not.toHaveBeenCalled();

    // Answering the re-ask should finalize immediately — every other field
    // (maxDistanceKm and the six soft buckets) is already collected and must
    // not be re-asked, and the wrap-up recap is not shown a second time.
    const done = await engine.handleMessage("45");

    expect(done.phaseComplete).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(calls[0].ageRange).toEqual({ min: 40, max: 45 });
    expect(calls[0].maxDistanceKm).toBe(50);
    expect(WantedProfileSchema.safeParse(calls[0]).success).toBe(true);
  });

  it("keeps probing the required ageMin fact instead of force-advancing to null", async () => {
    const { persist } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      mode: "interview_wants",
      runSoftTurn: softWants({ genderPreference: "female" }),
      persist,
    });

    await engine.handleMessage("start"); // greeting + genderPreference
    await engine.handleMessage("women"); // answer gender -> advance to ageMin
    const p1 = await engine.handleMessage("young-ish");
    const p2 = await engine.handleMessage("still vague");
    const p3 = await engine.handleMessage("dunno");

    // A required fact never force-advances, so it never completes on nulls.
    expect(p1.phaseComplete).toBe(false);
    expect(p2.phaseComplete).toBe(false);
    expect(p3.phaseComplete).toBe(false);
    expect(persist).not.toHaveBeenCalled();
  });
});
