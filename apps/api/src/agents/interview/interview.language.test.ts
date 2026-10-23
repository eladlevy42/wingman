import { describe, it, expect, vi } from "vitest";
import { UserProfileSchema, type InterviewLanguage } from "@wingman/shared";
import { InterviewEngine } from "./interview.engine";
import { t } from "./localized";
import { INTERVIEW_SELF_TREE } from "./questionTree";
import type { SoftTurnFn, SoftTurnParams } from "./softTurn";
import type { AddendumFn } from "./addendum";

// The interview language layer — ADR-0037. What matters here is the split the
// whole design rests on: the *conversation* changes language, the *extracted
// profile* never does. Everything below either checks that Barney speaks Hebrew
// or that what he stores is still the English-keyed, English-valued shape
// UserProfileSchema and the matching canonicalizer expect.

vi.mock("./addendum", () => ({ routeAddendum: async () => ({ kind: "none" }) }));

function makePersist() {
  const calls: Record<string, unknown>[] = [];
  const persist = vi.fn(async (_userId: string, profile: Record<string, unknown>) => {
    calls.push(profile);
  });
  return { persist, calls };
}

// A soft-turn fake standing in for Haiku honouring the prompt's contract: it is
// handed a Hebrew answer and returns an English extracted value plus a Hebrew
// acknowledgement. Records the params it was called with so the test can assert
// what the engine actually told the model.
function hebrewSoftTurn(seen: SoftTurnParams[]): SoftTurnFn {
  const english: Record<string, unknown> = {
    job: "software engineer",
    education: "computer science",
    conflict_style: "says it directly",
    emotional_openness: "open, works at it",
    treatment_of_others: "loyal and attentive",
    personality_traits: ["funny", "curious"],
    wants_kids: true,
    kids_timeline: "in a few years",
    faith: "somewhat",
    current_motivation: "building something stable",
    life_vision: "a family and a calmer job",
    // The sharp edge: a Hebrew answer of "בישול, ריצה" must reach the profile
    // as English hobby names, or matching's canonicalizer never overlaps them.
    hobbies: [{ name: "cooking" }, { name: "running" }],
    social_energy: "introvert",
    appearance: "casual and put-together",
    body_type: "athletic",
  };
  return async (params) => {
    seen.push(params);
    return {
      sufficient: true,
      extracted_value: english[params.node.field] ?? `value-${params.node.field}`,
      message: `הבנתי, ${params.node.field}`,
    };
  };
}

// Walks the whole Phase-1 tree answering in Hebrew, plus the "anything else?"
// wrap-up turn, and returns the persisted profile. The first two answers are
// shaped for the deterministic fact nodes (a number for age, a bare place name
// for city); everything after that is Hebrew prose the soft-turn fake accepts.
async function driveInterview(
  engine: InterviewEngine,
  calls: Record<string, unknown>[],
  opts: { start?: boolean; answers?: string[] } = {}
) {
  if (opts.start !== false) await engine.handleMessage("start");
  const scripted = opts.answers ?? ["30", "תל אביב"];
  let complete = false;
  let guard = 0;
  while (!complete && guard < 60) {
    const answer = scripted[guard] ?? "תשובה מפורטת בעברית על עצמי";
    guard += 1;
    const turn = await engine.handleMessage(answer);
    complete = turn.phaseComplete;
  }
  expect(complete).toBe(true);
  return calls[0];
}

describe("interview language — Hebrew is the default", () => {
  it("opens in Hebrew when no language is given", async () => {
    const { persist } = makePersist();
    const engine = new InterviewEngine("u1", {
      persist,
      runSoftTurn: hebrewSoftTurn([]),
    });

    const first = await engine.handleMessage("start");

    expect(engine.getLanguage()).toBe("he");
    expect(first.question).toBe(t(INTERVIEW_SELF_TREE[0].text, "he"));
    expect(first.question).not.toBe(t(INTERVIEW_SELF_TREE[0].text, "en"));
    // The section title the header shows is Hebrew too — a Hebrew question
    // under an English section heading is the half-translated failure mode.
    expect(first.section?.title).toBe("[redacted:he]");
  });

  it("opens in English when English is asked for", async () => {
    const { persist } = makePersist();
    const engine = new InterviewEngine("u1", { language: "en", persist });

    const first = await engine.handleMessage("start");

    expect(first.question).toBe(t(INTERVIEW_SELF_TREE[0].text, "en"));
    expect(first.section?.title).toBe("[redacted:en]");
  });

  it("localizes the interactive input control's options, not just the question", async () => {
    const { persist } = makePersist();
    const seen: SoftTurnParams[] = [];
    const engine = new InterviewEngine("u1", { persist, runSoftTurn: hebrewSoftTurn(seen) });

    await engine.handleMessage("start"); // age
    await engine.handleMessage("30"); // city
    let turn = await engine.handleMessage("תל אביב");
    // Walk until a choice control shows up (wants_kids is the first).
    let guard = 0;
    while (turn.input.kind !== "choice" && guard++ < 20) {
      turn = await engine.handleMessage("תשובה בעברית");
    }

    expect(turn.input.kind).toBe("choice");
    if (turn.input.kind === "choice") {
      expect(turn.input.options.map((o) => o.label)).toEqual([
        "[redacted:he]",
        "[redacted:he]",
        "[redacted:he]",
      ]);
      // The value is what the client sends back as the user's own message, so
      // it has to read as Hebrew too.
      expect(turn.input.options[0].value).toBe("[redacted:he]");
    }
  });
});

describe("interview language — the toggle", () => {
  it("switches the language of the next question without losing collected answers", async () => {
    const { persist, calls } = makePersist();
    const engine = new InterviewEngine("u1", { persist, runSoftTurn: hebrewSoftTurn([]) });

    await engine.handleMessage("start");
    const afterAge = await engine.handleMessage("30");
    expect(afterAge.question).toBe(t(INTERVIEW_SELF_TREE[1].text, "he"));

    engine.setLanguage("en");
    const afterCity = await engine.handleMessage("תל אביב");

    expect(engine.getLanguage()).toBe("en");
    // The next question is English, and the answers given in Hebrew survive.
    expect(afterCity.question).toBe(t(INTERVIEW_SELF_TREE[2].text, "en"));
    const saved = await driveInterview(engine, calls, { start: false, answers: [] });
    expect(saved.age).toBe(30);
    expect(saved.city).toBe("תל אביב");
  });

  it("switches Barney's own deterministic copy too, not only the tree", async () => {
    const { persist } = makePersist();
    const engine = new InterviewEngine("u1", { persist, runSoftTurn: hebrewSoftTurn([]) });

    await engine.handleMessage("start");
    const heAck = await engine.handleMessage("30");
    // The fact acknowledgement is written by the engine, not by the tree and
    // not by the model.
    expect(heAck.acknowledgement).toBe("[redacted:ack-he-0]");

    engine.setLanguage("en");
    const enAck = await engine.handleMessage("Tel Aviv");
    expect(enAck.acknowledgement).toBe("[redacted:ack-en-1]");
  });

  it("restates the pending question in the new language without advancing", async () => {
    const { persist, calls } = makePersist();
    const engine = new InterviewEngine("u1", { persist, runSoftTurn: hebrewSoftTurn([]) });

    const first = await engine.handleMessage("start");
    expect(first.question).toBe(t(INTERVIEW_SELF_TREE[0].text, "he"));

    engine.setLanguage("en");
    const restated = engine.restatePending();

    expect(restated).not.toBeNull();
    expect(restated?.question).toBe(t(INTERVIEW_SELF_TREE[0].text, "en"));
    expect(restated?.acknowledgement).toBeNull();
    expect(restated?.section?.title).toBe("[redacted:en]");
    expect(restated?.input.kind).toBe("age");
    expect(restated?.phaseComplete).toBe(false);
    // Still on the same question: the next answer is the age, not the city.
    const afterAge = await engine.handleMessage("30");
    expect(afterAge.question).toBe(t(INTERVIEW_SELF_TREE[1].text, "en"));
    const saved = await driveInterview(engine, calls, { start: false, answers: ["תל אביב"] });
    expect(saved.age).toBe(30);
  });

  it("restates a choice question's answer chips in the new language", async () => {
    const { persist } = makePersist();
    const engine = new InterviewEngine("u1", { persist, runSoftTurn: hebrewSoftTurn([]) });

    await engine.handleMessage("start");
    await engine.handleMessage("30");
    let turn = await engine.handleMessage("תל אביב");
    let guard = 0;
    while (turn.input.kind !== "choice" && guard++ < 20) {
      turn = await engine.handleMessage("תשובה בעברית");
    }
    expect(turn.input.kind).toBe("choice");

    engine.setLanguage("en");
    const restated = engine.restatePending();

    expect(restated?.input.kind).toBe("choice");
    if (restated?.input.kind === "choice") {
      expect(restated.input.options.map((o) => o.label)).not.toContain("כן");
      expect(restated.input.options[0].label).toMatch(/^[\x20-\x7E]+$/);
    }
  });

  it("restates the wrap-up in the new language", async () => {
    const { persist } = makePersist();
    const engine = new InterviewEngine("u1", { persist, runSoftTurn: hebrewSoftTurn([]) });

    await engine.handleMessage("start");
    await engine.handleMessage("30");
    let turn = await engine.handleMessage("תל אביב");
    let guard = 0;
    // The wrap-up is the only turn with the whole tree answered but no section.
    while (!(turn.section === null && turn.progress.answered === turn.progress.total)) {
      if (guard++ > 60) throw new Error("never reached the wrap-up");
      turn = await engine.handleMessage("תשובה מפורטת בעברית על עצמי");
    }

    engine.setLanguage("en");
    const restated = engine.restatePending();

    expect(restated?.question).toBeTruthy();
    expect(restated?.question).not.toMatch(/[֐-׿]/);
    expect(restated?.section).toBeNull();
    expect(restated?.input).toEqual({ kind: "text" });
  });

  it("has nothing to restate before the interview starts", () => {
    const engine = new InterviewEngine("u1", { persist: makePersist().persist });
    expect(engine.restatePending()).toBeNull();
  });

  it("honours a Hebrew 'go back' phrase", async () => {
    const { persist } = makePersist();
    const engine = new InterviewEngine("u1", { persist, runSoftTurn: hebrewSoftTurn([]) });

    await engine.handleMessage("start");
    await engine.handleMessage("30");
    const back = await engine.handleMessage("חזור אחורה");

    expect(back.acknowledgement).toBe("[redacted:back-he]");
    expect(back.question).toBe(t(INTERVIEW_SELF_TREE[0].text, "he"));
  });
});

describe("interview language — the extraction contract", () => {
  it("produces a schema-valid, English-valued profile from a fully Hebrew interview", async () => {
    const { persist, calls } = makePersist();
    const seen: SoftTurnParams[] = [];
    const engine = new InterviewEngine("u1", { persist, runSoftTurn: hebrewSoftTurn(seen) });

    const saved = await driveInterview(engine, calls);

    // The whole point: the same English-keyed shape the English path produces.
    const parsed = UserProfileSchema.safeParse(saved);
    expect(parsed.success).toBe(true);
    expect(saved.social_energy).toBe("introvert");
    expect(saved.wants_kids).toBe(true);
    expect(saved.hobbies).toEqual([{ name: "cooking" }, { name: "running" }]);
    expect(saved.age).toBe(30);
  });

  it("tells the soft-turn model which language to reply in, per turn", async () => {
    const { persist } = makePersist();
    const seen: SoftTurnParams[] = [];
    const engine = new InterviewEngine("u1", { persist, runSoftTurn: hebrewSoftTurn(seen) });

    await engine.handleMessage("start");
    await engine.handleMessage("30");
    await engine.handleMessage("תל אביב"); // city answered — job is the first soft node
    await engine.handleMessage("אני מהנדס תוכנה");

    expect(seen[0].language).toBe("he");
    // The model is shown the wording the user was actually shown.
    expect(seen[0].questionText).toBe(t(INTERVIEW_SELF_TREE[2].text, "he"));

    engine.setLanguage("en");
    await engine.handleMessage("I study computer science");
    expect(seen[1].language).toBe("en");
    expect(seen[1].questionText).toBe(t(INTERVIEW_SELF_TREE[3].text, "en"));
  });

  it("passes the language to the wrap-up addendum router", async () => {
    const { persist, calls } = makePersist();
    const seen: SoftTurnParams[] = [];
    const routeAddendum = vi.fn<AddendumFn>().mockResolvedValue({ kind: "none" });
    const engine = new InterviewEngine("u1", {
      persist,
      runSoftTurn: hebrewSoftTurn(seen),
      routeAddendum,
    });

    await driveInterview(engine, calls);

    expect(routeAddendum).toHaveBeenCalledWith(
      expect.objectContaining({ language: "he" as InterviewLanguage })
    );
  });
});
