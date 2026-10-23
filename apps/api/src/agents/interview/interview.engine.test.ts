import { describe, it, expect, vi } from "vitest";
import { InterviewEngine } from "./interview.engine";
import { t } from "./localized";
import { INTERVIEW_SELF_TREE, type QuestionNode } from "./questionTree";
import type { SoftTurnFn, SoftTurnParams } from "./softTurn";
import { WINGMAN_COUNTRY } from "@wingman/shared";

// Default the end-of-interview "anything else?" router (#251) to "nothing to
// add", so every existing walk finalizes exactly as before the wrap-up turn was
// introduced — just one extra turn to decline it. Tests that exercise the
// addendum routing itself inject their own routeAddendum via deps, which takes
// precedence over this module default.
vi.mock("./addendum", () => ({
  routeAddendum: async () => ({ kind: "none" }),
}));

// Deterministic stand-ins for the two injected dependencies, so the whole flow
// runs without the Anthropic API or the database.

function makePersist() {
  const calls: Record<string, unknown>[] = [];
  // The transcript handed to persist on each call (#488), parallel to `calls`.
  const transcripts: string[] = [];
  const persist = vi.fn(
    async (_userId: string, profile: Record<string, unknown>, rawTranscript: string) => {
      calls.push(profile);
      transcripts.push(rawTranscript);
    }
  );
  return { persist, calls, transcripts };
}

// A soft-turn fake that always judges the answer sufficient and returns a
// per-field canned value, letting a full happy-path interview run to completion.
// Defaults are schema-valid so finalize() validation passes; callers override
// per field as needed.
function softAlwaysSufficient(values: Partial<Record<string, unknown>>): SoftTurnFn {
  const valid: Record<string, unknown> = {
    hobbies: [],
    personality_traits: [],
    social_energy: "ambivert",
    wants_kids: "undecided",
  };
  return async ({ node }: SoftTurnParams) => ({
    sufficient: true,
    extracted_value: Object.prototype.hasOwnProperty.call(values, node.field)
      ? values[node.field]
      : (valid[node.field] ?? `value-${node.field}`),
    message: `ack-${node.field}`,
  });
}

describe("InterviewEngine — opening", () => {
  it("returns the greeting plus the first question on the first turn, ignoring input", async () => {
    const engine = new InterviewEngine("u1", {
      language: "en",
      runSoftTurn: softAlwaysSufficient({}),
      persist: makePersist().persist,
    });

    const first = await engine.handleMessage("whatever");

    expect(first.phaseComplete).toBe(false);
    expect(first.reply).toContain(t(INTERVIEW_SELF_TREE[0].text, "en")); // "How old are you?"
  });
});

describe("InterviewEngine — turn metadata", () => {
  it("splits the greeting from the first question and reports section, progress, and input", async () => {
    const engine = new InterviewEngine("u1", {
      language: "en",
      runSoftTurn: softAlwaysSufficient({}),
      persist: makePersist().persist,
    });

    const first = await engine.handleMessage("start");

    expect(first.acknowledgement).toContain("[redacted:en]");
    expect(first.question).toBe(t(INTERVIEW_SELF_TREE[0].text, "en")); // "How old are you?"
    // reply stays the two joined, for clients not consuming the split fields.
    expect(first.reply).toBe(`${first.acknowledgement} ${first.question}`);
    expect(first.section).toEqual({ title: "[redacted:en]", index: 1, total: 6 });
    expect(first.progress).toEqual({ answered: 0, total: INTERVIEW_SELF_TREE.length });
    expect(first.input).toEqual({ kind: "age", min: 18, max: 120 });
  });

  it("varies fact acknowledgements across consecutive fact answers and advances progress", async () => {
    const engine = new InterviewEngine("u1", {
      language: "en",
      runSoftTurn: softAlwaysSufficient({}),
      persist: makePersist().persist,
    });

    await engine.handleMessage("start"); // age question
    const afterAge = await engine.handleMessage("30"); // age -> city
    const afterCity = await engine.handleMessage("Nowhereville"); // city -> job

    expect(afterAge.acknowledgement).toBeTruthy();
    expect(afterCity.acknowledgement).toBeTruthy();
    // No longer always "Got it." — consecutive fact acks differ.
    expect(afterAge.acknowledgement).not.toBe(afterCity.acknowledgement);
    const cityNode = INTERVIEW_SELF_TREE.find((n) => n.field === "city")!;
    expect(afterAge.question).toBe(t(cityNode.text, "en"));
    expect(afterAge.progress.answered).toBe(1);
    expect(afterCity.progress.answered).toBe(2);
  });

  it("reports phaseComplete with full progress on the final turn", async () => {
    const { persist, calls } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      runSoftTurn: softAlwaysSufficient({ wants_kids: false, social_energy: "introvert" }),
      persist,
    });

    await engine.handleMessage("start");
    let turn = await engine.handleMessage("I'm 30 in Tel Aviv, Israel.");
    let guard = 0;
    while (!turn.phaseComplete && guard++ < 60) {
      turn = await engine.handleMessage("I'm 30 in Tel Aviv, Israel.");
    }

    expect(turn.phaseComplete).toBe(true);
    expect(turn.progress.answered).toBe(turn.progress.total);
    expect(calls).toHaveLength(1);
  });
});

// #530 — the country question was removed entirely. Wingman is Israel-only, so
// the field is filled from a constant instead of costing an interview turn.
// Replaces the old "city implies country" pair, which covered the skipIf branch
// that inferred the country from a well-known city and asked for it otherwise.
describe("InterviewEngine — country is never asked", () => {
  it("fills country from the constant without ever asking, whatever the city", async () => {
    const { persist, calls } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      runSoftTurn: softAlwaysSufficient({
        wants_kids: false,
        hobbies: [],
        social_energy: "ambivert",
      }),
      persist,
    });

    const replies: string[] = [];
    await engine.handleMessage("start"); // greeting + age
    replies.push((await engine.handleMessage("30")).reply); // age -> city question
    replies.push((await engine.handleMessage("Tel Aviv")).reply); // city -> next question

    let phaseComplete = false;
    let guard = 0;
    while (!phaseComplete && guard++ < 50) {
      const turn = await engine.handleMessage("something reasonable");
      replies.push(turn.reply);
      phaseComplete = turn.phaseComplete;
    }

    expect(replies.some((r) => /which country/i.test(r))).toBe(false);
    expect(calls[0].city).toBe("Tel Aviv");
    expect(calls[0].country).toBe(WINGMAN_COUNTRY);
  });

  it("fills country even for a city the geo lookup does not recognise", async () => {
    const { persist, calls } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      runSoftTurn: softAlwaysSufficient({
        wants_kids: false,
        hobbies: [],
        social_energy: "ambivert",
      }),
      persist,
    });

    const replies: string[] = [];
    await engine.handleMessage("start");
    await engine.handleMessage("30");
    replies.push((await engine.handleMessage("Nowhereville")).reply);

    let phaseComplete = false;
    let guard = 0;
    while (!phaseComplete && guard++ < 50) {
      const turn = await engine.handleMessage("something reasonable");
      replies.push(turn.reply);
      phaseComplete = turn.phaseComplete;
    }

    expect(replies.some((r) => /which country/i.test(r))).toBe(false);
    expect(calls[0].country).toBe(WINGMAN_COUNTRY);
  });
});

describe("InterviewEngine — full walk and assembly", () => {
  it("walks every bucket and persists the incrementally assembled profile once", async () => {
    const { persist, calls } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      runSoftTurn: softAlwaysSufficient({
        wants_kids: true,
        kids_timeline: "2-3 years",
        hobbies: [{ name: "climbing", centrality: "high", solo_or_social: "social" }],
        social_energy: "ambivert",
      }),
      persist,
    });

    // A generic answer that satisfies every deterministic fact extractor: it
    // contains a number (age) and is non-trivial (city/country/height/hometown).
    const answer = "I'm 30, living in Tel Aviv, Israel.";

    await engine.handleMessage("start"); // greeting + Q1
    let phaseComplete = false;
    let guard = 0;
    while (!phaseComplete && guard++ < 50) {
      const turn = await engine.handleMessage(answer);
      phaseComplete = turn.phaseComplete;
    }

    expect(phaseComplete).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);

    const saved = calls[0];
    expect(saved.age).toBe(30);
    expect(saved.wants_kids).toBe(true);
    expect(saved.kids_timeline).toBe("2-3 years"); // branch ran because wants_kids === true
    expect(saved.hobbies).toEqual([
      { name: "climbing", centrality: "high", solo_or_social: "social" },
    ]);
    expect(saved.social_energy).toBe("ambivert");
    // The field-symmetry node must actually land in the persisted profile — a
    // field/assembleSelf mismatch would otherwise pass silently (#252). (The
    // other symmetry node this test originally checked, body_type, was cut in
    // #417.)
    expect(saved.faith).toBe("value-faith");
    expect(saved.personality_traits).toEqual([]);
  });

  it("skips the kids-timeline branch when the user does not want kids", async () => {
    const { persist, calls } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      runSoftTurn: softAlwaysSufficient({ wants_kids: false, social_energy: "introvert" }),
      persist,
    });

    const replies: string[] = [];
    await engine.handleMessage("start");
    let phaseComplete = false;
    let guard = 0;
    while (!phaseComplete && guard++ < 50) {
      const turn = await engine.handleMessage("I'm 30 in Tel Aviv, Israel.");
      replies.push(turn.reply);
      phaseComplete = turn.phaseComplete;
    }

    const timelineNode = INTERVIEW_SELF_TREE.find((n) => n.field === "kids_timeline")!;
    expect(replies.some((r) => r.includes(t(t(timelineNode.text, "en"), "he")))).toBe(false);
    expect(calls[0].kids_timeline).toBeNull();
  });

  // Guards item #2 ("Barney never repeats a question"): walking the real tree to
  // completion, every distinct tree question is presented at most once. The
  // engine's forward-only nextPlayableIndex + "skip already-collected fields" is
  // what makes this hold; this test would fail the moment an answered node could
  // be re-presented on its own.
  it("never presents the same question twice across a full interview (#279)", async () => {
    const { persist } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      runSoftTurn: softAlwaysSufficient({
        wants_kids: true,
        kids_timeline: "2-3 years",
        social_energy: "ambivert",
      }),
      persist,
    });

    const treeTexts = new Set(INTERVIEW_SELF_TREE.map((n) => t(n.text, "en")));
    const questionsAsked: string[] = [];
    const record = (q: string | null) => {
      if (q && treeTexts.has(q)) questionsAsked.push(q);
    };

    record((await engine.handleMessage("start")).question);
    let phaseComplete = false;
    let guard = 0;
    while (!phaseComplete && guard++ < 50) {
      const turn = await engine.handleMessage("I'm 30, living in Tel Aviv, Israel.");
      record(turn.question);
      phaseComplete = turn.phaseComplete;
    }

    expect(phaseComplete).toBe(true);
    // A real interview happened (not a vacuous pass)...
    expect(questionsAsked.length).toBeGreaterThan(3);
    // ...and no tree question was ever shown more than once.
    expect(new Set(questionsAsked).size).toBe(questionsAsked.length);
  });
});

describe("InterviewEngine — required fields and finalize safety net", () => {
  it("never force-advances a required fact field, so it cannot crash finalize", async () => {
    const { persist } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      runSoftTurn: softAlwaysSufficient({}),
      persist,
    });

    await engine.handleMessage("start"); // greeting + age (required)
    const r1 = await engine.handleMessage("no number");
    const r2 = await engine.handleMessage("still nothing");
    const r3 = await engine.handleMessage("nope");

    const ageNode = INTERVIEW_SELF_TREE[0];
    const ageProbe = ageNode.kind === "fact" ? t(ageNode.probe, "en") : "";

    // Required age keeps probing past the cap instead of advancing to null.
    expect(r1.phaseComplete).toBe(false);
    expect(r2.phaseComplete).toBe(false);
    expect(r3.phaseComplete).toBe(false);
    expect(r3.reply).toBe(ageProbe);
    expect(persist).not.toHaveBeenCalled();
  });

  it("re-asks instead of crashing when a soft field force-advances an invalid value", async () => {
    let socialEnergyAttempts = 0;
    const runSoftTurn: SoftTurnFn = async ({ node }: SoftTurnParams) => {
      if (node.field === "social_energy") {
        socialEnergyAttempts += 1;
        // First pass yields an invalid enum value; the re-ask yields a valid one.
        return {
          sufficient: true,
          extracted_value: socialEnergyAttempts === 1 ? "weird" : "ambivert",
          message: "ack-social_energy",
        };
      }
      const canned: Record<string, unknown> = {
        wants_kids: false,
        hobbies: [{ name: "x", centrality: "y", solo_or_social: "z" }],
        personality_traits: [],
      };
      return {
        sufficient: true,
        extracted_value: canned[node.field] ?? `value-${node.field}`,
        message: `ack-${node.field}`,
      };
    };
    const { persist, calls } = makePersist();
    const engine = new InterviewEngine("u1", { language: "en", runSoftTurn, persist });

    const replies: string[] = [];
    await engine.handleMessage("start");
    let phaseComplete = false;
    let guard = 0;
    while (!phaseComplete && guard++ < 60) {
      const turn = await engine.handleMessage("I'm 30 in Tel Aviv, Israel.");
      replies.push(turn.reply);
      phaseComplete = turn.phaseComplete;
    }

    // It never threw, validated before persisting, and re-asked the bad field.
    expect(phaseComplete).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(calls[0].social_energy).toBe("ambivert");
    expect(replies.some((r) => r.includes("[redacted:lock-en]"))).toBe(true);
  });
});

// The three schema-required fact nodes, with cooperative extractors. Appended to
// the focused cap trees below so finalize() can validate and complete — the real
// tree always includes these. A generic answer like "I'm 30, Tel Aviv, Israel"
// satisfies all three.
const nonEmpty = (answer: string) =>
  answer.trim().length >= 2
    ? { sufficient: true, value: answer.trim() }
    : { sufficient: false, value: null };

const requiredFacts: QuestionNode[] = [
  {
    field: "age",
    bucket: 1,
    text: "How old are you?",
    kind: "fact",
    extract: (answer) => {
      const match = answer.match(/\d+/);
      return match
        ? { sufficient: true, value: Number(match[0]) }
        : { sufficient: false, value: null };
    },
    probe: "I need a number.",
    required: true,
  },
  {
    field: "city",
    bucket: 1,
    text: "Which city?",
    kind: "fact",
    extract: nonEmpty,
    probe: "City?",
    required: true,
  },
  {
    field: "country",
    bucket: 1,
    text: "Which country?",
    kind: "fact",
    extract: nonEmpty,
    probe: "Country?",
    required: true,
  },
  // Not a required *fact*, but every tree here finalizes against
  // UserProfileSchema, and `hobbies` is deliberately no longer defaulted to []
  // during assembly (#529) — an unasked hobbies field now fails validation
  // rather than being silently filled in. So a partial tree must still ask it
  // to reach a valid profile, exactly as it must still ask age/city/country.
  {
    field: "hobbies",
    bucket: 4,
    text: "What do you do for fun?",
    kind: "soft",
  },
];

// Drives cooperative answers until the interview completes, returning the saved
// profile. The required facts accept "I'm 30, Tel Aviv, Israel".
async function driveToCompletion(
  engine: InterviewEngine,
  calls: Record<string, unknown>[]
): Promise<Record<string, unknown>> {
  let phaseComplete = false;
  let guard = 0;
  while (!phaseComplete && guard++ < 60) {
    const turn = await engine.handleMessage("I'm 30, Tel Aviv, Israel.");
    phaseComplete = turn.phaseComplete;
  }
  return calls[0];
}

describe("InterviewEngine — skip and back navigation", () => {
  // Two non-required soft nodes ahead of the required facts, so skip/back can be
  // exercised on skippable questions and the interview still finalizes valid.
  const navTree: QuestionNode[] = [
    { field: "job", bucket: 1, text: "What do you do?", kind: "soft" },
    { field: "faith", bucket: 1, text: "Faith in your life?", kind: "soft" },
    ...requiredFacts,
  ];

  it("advances immediately on an explicit 'skip' and stores null for that field", async () => {
    const { persist, calls } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      tree: navTree,
      runSoftTurn: softAlwaysSufficient({}),
      persist,
    });

    await engine.handleMessage("start"); // greeting + "What do you do?"
    await engine.handleMessage("I design apps."); // answer job → "Faith in your life?"
    const afterSkip = await engine.handleMessage("skip"); // skip faith → first required fact

    expect(afterSkip.question).toBe("How old are you?");

    await driveToCompletion(engine, calls);
    expect(calls[0].job).toBe("value-job");
    expect(calls[0].faith).toBeNull();
  });

  it("returns to the previous question on 'go back' and clears that answer", async () => {
    const { persist } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      tree: navTree,
      runSoftTurn: softAlwaysSufficient({}),
      persist,
    });

    await engine.handleMessage("start"); // "What do you do?"
    await engine.handleMessage("I design apps."); // → "Faith in your life?"
    const afterBack = await engine.handleMessage("go back"); // back → "What do you do?"

    expect(afterBack.question).toBe("What do you do?");
    // The re-asked question describes the same (job) node, not the faith node.
    expect(afterBack.section).not.toBeNull();
  });

  it("tells the user there is nothing before the first question", async () => {
    const { persist } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      tree: navTree,
      runSoftTurn: softAlwaysSufficient({}),
      persist,
    });

    await engine.handleMessage("start"); // on the first question
    const back = await engine.handleMessage("go back");

    expect(back.question).toBe("[redacted:first-en]");
  });
});

describe("InterviewEngine — fact probe cap", () => {
  // A non-required height fact whose extractor needs a digit, so non-numeric
  // answers are insufficient and the cap can be exercised.
  const heightTree: QuestionNode[] = [
    {
      field: "height",
      bucket: 1,
      text: "How tall are you?",
      kind: "fact",
      extract: (answer) =>
        /\d/.test(answer)
          ? { sufficient: true, value: answer.trim() }
          : { sufficient: false, value: null },
      probe: "I need a number.",
    },
    ...requiredFacts,
  ];

  it("probes a non-required fact once, then force-advances and stores null", async () => {
    const { persist, calls } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      tree: heightTree,
      runSoftTurn: softAlwaysSufficient({}),
      persist,
    });

    await engine.handleMessage("start");
    const p1 = await engine.handleMessage("no idea");
    const forced = await engine.handleMessage("still none"); // force-advance height -> null

    expect(p1.reply).toBe("I need a number.");
    expect(p1.phaseComplete).toBe(false);
    expect(forced.phaseComplete).toBe(false); // advanced to the next question, not done

    const saved = await driveToCompletion(engine, calls);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(saved.height).toBeNull();
    expect(saved.age).toBe(30);
  });

  it("throws if a turn arrives after the interview is complete", async () => {
    const { persist, calls } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      tree: requiredFacts,
      runSoftTurn: softAlwaysSufficient({}),
      persist,
    });

    await engine.handleMessage("start");
    await driveToCompletion(engine, calls);
    await expect(engine.handleMessage("again")).rejects.toThrow(/already complete/);
  });
});

describe("InterviewEngine — side questions", () => {
  it("routes an answer that looks like a question to the side-question handler instead of the fact extractor, without advancing or spending a probe", async () => {
    const { persist, calls } = makePersist();
    const answerSideQuestion = vi.fn(
      async ({ pendingQuestion }: { pendingQuestion: string }) =>
        `Because reasons. ${pendingQuestion}`
    );
    const engine = new InterviewEngine("u1", {
      language: "en",
      tree: requiredFacts,
      runSoftTurn: softAlwaysSufficient({}),
      answerSideQuestion,
      persist,
    });

    await engine.handleMessage("start"); // greeting + age question
    const aside = await engine.handleMessage("why do you need my age?");

    expect(answerSideQuestion).toHaveBeenCalledWith({
      pendingQuestion: t(requiredFacts[0].text, "en"),
      userQuestion: "why do you need my age?",
      language: "en",
      // Threaded through so the helper's call is attributed on AgentCall (#553).
      userId: "u1",
      addressForm: "plural",
    });
    expect(aside.reply).toBe(`Because reasons. ${t(requiredFacts[0].text, "en")}`);
    expect(aside.phaseComplete).toBe(false);

    // The pending question is still active — a real answer now advances normally.
    const answered = await engine.handleMessage("30");
    expect(answered.reply).toContain(t(requiredFacts[1].text, "en")); // advanced to the city question

    const saved = await driveToCompletion(engine, calls);
    expect(saved.age).toBe(30);
  });

  it("never consumes the probe budget for side questions, so a required fact keeps asking indefinitely", async () => {
    const { persist } = makePersist();
    const answerSideQuestion = vi.fn(async () => "Because reasons.");
    const engine = new InterviewEngine("u1", {
      language: "en",
      tree: requiredFacts,
      runSoftTurn: softAlwaysSufficient({}),
      answerSideQuestion,
      persist,
    });

    await engine.handleMessage("start");
    await engine.handleMessage("why?");
    await engine.handleMessage("but why though?");
    const third = await engine.handleMessage("seriously why?");

    expect(third.phaseComplete).toBe(false);
    expect(answerSideQuestion).toHaveBeenCalledTimes(3);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("InterviewEngine — side questions do not defeat MAX_PROBES on non-required nodes", () => {
  it("force-advances a soft node once MAX_PROBES side questions have been asked, instead of stalling forever", async () => {
    const jobTree: QuestionNode[] = [
      {
        field: "job",
        bucket: 1,
        text: "What do you do?",
        kind: "soft",
        sufficiencyGuidance: "n/a",
        extractHint: "string",
      },
      ...requiredFacts,
    ];
    const answerSideQuestion = vi.fn(async () => "Because reasons.");
    const { persist, calls } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      tree: jobTree,
      runSoftTurn: softAlwaysSufficient({}),
      answerSideQuestion,
      persist,
    });

    await engine.handleMessage("start"); // greeting + job question
    const p1 = await engine.handleMessage("why do you ask?");
    const forced = await engine.handleMessage("but why though?"); // MAX_PROBES reached -> force-advance

    expect(p1.phaseComplete).toBe(false);
    expect(answerSideQuestion).toHaveBeenCalledTimes(1); // only while probe budget remained
    expect(forced.reply).not.toBe("Because reasons."); // no longer routed to the side-question handler
    expect(forced.phaseComplete).toBe(false); // advanced to the next question, not stuck

    const saved = await driveToCompletion(engine, calls);
    expect(saved.job).not.toBeNull(); // force-advanced with a best-effort value, not stuck asking forever
  });

  it("force-advances a non-required fact node once MAX_PROBES side questions have been asked", async () => {
    const heightTree: QuestionNode[] = [
      {
        field: "height",
        bucket: 1,
        text: "How tall are you?",
        kind: "fact",
        extract: () => ({ sufficient: false, value: null }),
        probe: "I need a number.",
      },
      ...requiredFacts,
    ];
    const answerSideQuestion = vi.fn(async () => "Because reasons.");
    const { persist, calls } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      tree: heightTree,
      runSoftTurn: softAlwaysSufficient({}),
      answerSideQuestion,
      persist,
    });

    await engine.handleMessage("start");
    await engine.handleMessage("why do you need that?");
    const forced = await engine.handleMessage("but why though?"); // MAX_PROBES reached -> force-advance

    expect(answerSideQuestion).toHaveBeenCalledTimes(1); // only while probe budget remained
    expect(forced.phaseComplete).toBe(false); // advanced to the next question, not stuck

    const saved = await driveToCompletion(engine, calls);
    expect(saved.height).toBeNull(); // force-advanced with null since extract never succeeds
  });
});

describe("InterviewEngine — soft probe cap", () => {
  const jobTree: QuestionNode[] = [
    {
      field: "job",
      bucket: 1,
      text: "What do you do?",
      kind: "soft",
      sufficiencyGuidance: "n/a",
      extractHint: "string",
    },
    ...requiredFacts,
  ];

  it("force-advances a soft node on the second attempt, passing mustAdvance to the model", async () => {
    const seen: boolean[] = [];
    const runSoftTurn: SoftTurnFn = async ({ node, mustAdvance }: SoftTurnParams) => {
      if (node.field !== "job") {
        // hobbies must be a valid array — a stray string there now re-asks
        // instead of assembling to [] (#529), which would stall this walk.
        const value = node.field === "hobbies" ? [] : `value-${node.field}`;
        return { sufficient: true, extracted_value: value, message: "ack" };
      }
      seen.push(mustAdvance);
      return {
        sufficient: false,
        extracted_value: mustAdvance ? "best-effort" : null,
        message: "Can you be more specific?",
      };
    };
    const { persist, calls } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      tree: jobTree,
      runSoftTurn,
      persist,
    });

    await engine.handleMessage("start");
    const p1 = await engine.handleMessage("stuff");
    await engine.handleMessage("things"); // mustAdvance -> stores best-effort, advances

    expect(p1.phaseComplete).toBe(false);
    expect(seen).toEqual([false, true]); // cap enforced in code

    const saved = await driveToCompletion(engine, calls);
    expect(saved.job).toBe("best-effort"); // best-effort value stored on force-advance
  });
});

describe("InterviewEngine — wrap-up recap and addendum (#251)", () => {
  // Drives cooperative answers until Barney offers the wrap-up recap — the turn
  // just before finalize. Detected by the recap's "[redacted:wrapup" prompt.
  async function driveToWrapup(engine: InterviewEngine): Promise<void> {
    await engine.handleMessage("start");
    let turn = await engine.handleMessage("I'm 30, Tel Aviv, Israel.");
    let guard = 0;
    while (!turn.reply.includes("[redacted:wrapup") && guard++ < 60) {
      turn = await engine.handleMessage("I'm 30, Tel Aviv, Israel.");
    }
  }

  it("offers a one-line recap of the section titles and invites an addition before finalizing", async () => {
    const engine = new InterviewEngine("u1", {
      language: "en",
      runSoftTurn: softAlwaysSufficient({ wants_kids: false, social_energy: "introvert" }),
      persist: makePersist().persist,
      routeAddendum: async () => ({ kind: "none" }),
    });

    await engine.handleMessage("start");
    let wrapup = await engine.handleMessage("I'm 30, Tel Aviv, Israel.");
    let guard = 0;
    while (!wrapup.reply.includes("[redacted:wrapup") && guard++ < 60) {
      wrapup = await engine.handleMessage("I'm 30, Tel Aviv, Israel.");
    }

    expect(wrapup.phaseComplete).toBe(false);
    expect(wrapup.reply).toContain("[redacted:wrapup");
    // The recap lists the Phase-1 section titles, not raw question text.
    expect(wrapup.reply).toContain("[redacted:en]");
    // No pending tree node: the input is free text and no section is reported.
    expect(wrapup.input).toEqual({ kind: "text" });
    expect(wrapup.section).toBeNull();
  });

  it("finalizes without changes when the user has nothing to add", async () => {
    const { persist, calls } = makePersist();
    const routeAddendum = vi.fn(async () => ({ kind: "none" as const }));
    const engine = new InterviewEngine("u1", {
      language: "en",
      runSoftTurn: softAlwaysSufficient({ wants_kids: false, social_energy: "introvert" }),
      persist,
      routeAddendum,
    });

    await driveToWrapup(engine);
    const done = await engine.handleMessage("no, that's everything");

    expect(routeAddendum).toHaveBeenCalledTimes(1);
    expect(done.phaseComplete).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(calls[0].additionalNotes).toBeNull();
    // Nothing to acknowledge — the UI gets just the closing line, not an empty
    // acknowledgement bubble.
    expect(done.acknowledgement).toBeNull();
  });

  it("updates the matched field when the addendum corrects an existing answer", async () => {
    const { persist, calls } = makePersist();
    const routeAddendum = vi.fn(async () => ({
      kind: "existing_field" as const,
      field: "job",
      value: "corrected-job",
    }));
    const engine = new InterviewEngine("u1", {
      language: "en",
      runSoftTurn: softAlwaysSufficient({ wants_kids: false, social_energy: "introvert" }),
      persist,
      routeAddendum,
    });

    await driveToWrapup(engine);
    const done = await engine.handleMessage("actually my job changed");

    expect(done.phaseComplete).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(calls[0].job).toBe("corrected-job");
  });

  it("does not overwrite a collected field when existing_field is missing a value", async () => {
    const { persist, calls } = makePersist();
    const routeAddendum = vi.fn(async () => ({
      kind: "existing_field" as const,
      field: "job",
      value: undefined,
    }));
    const engine = new InterviewEngine("u1", {
      language: "en",
      runSoftTurn: softAlwaysSufficient({ wants_kids: false, social_energy: "introvert" }),
      persist,
      routeAddendum,
    });

    await driveToWrapup(engine);
    const done = await engine.handleMessage("actually my job changed");

    expect(done.phaseComplete).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(calls[0].job).not.toBeNull();
    expect(calls[0].job).not.toBeUndefined();
  });

  it("saves a free-form note to additionalNotes when the addendum fits no field", async () => {
    const { persist, calls } = makePersist();
    const routeAddendum = vi.fn(async () => ({
      kind: "new_note" as const,
      value: "I once sailed across the Atlantic.",
    }));
    const engine = new InterviewEngine("u1", {
      language: "en",
      runSoftTurn: softAlwaysSufficient({ wants_kids: false, social_energy: "introvert" }),
      persist,
      routeAddendum,
    });

    await driveToWrapup(engine);
    const done = await engine.handleMessage("one more thing worth mentioning");

    expect(done.phaseComplete).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(calls[0].additionalNotes).toBe("I once sailed across the Atlantic.");
  });
});

// #529: `hobbies` used to be assembled as `c.hobbies ?? []`. Because an empty
// array is schema-valid, a failed or partial extraction assembled into `[]`,
// passed validation and was persisted — the answer lost with no error and no
// re-ask, on the heaviest-weighted field in matching. These pin the three
// outcomes that replaced that single silent one.
describe("InterviewEngine — hobbies are never silently coerced (#529)", () => {
  const hobbyTree: QuestionNode[] = [
    {
      field: "hobbies",
      bucket: 4,
      text: "What do you do for fun?",
      kind: "soft",
      extractHint: "an array of objects, each { name: string }",
    },
    ...requiredFacts.filter((n) => n.field !== "hobbies"),
  ];

  // Answers the tree with a caller-supplied hobbies value the first time it is
  // asked, then a valid one on any re-ask — so a walk that re-asks still
  // terminates and we can see what was finally saved.
  function softWithHobbies(first: unknown): { run: SoftTurnFn; asked: () => number } {
    let hobbyTurns = 0;
    const run: SoftTurnFn = async ({ node }: SoftTurnParams) => {
      if (node.field !== "hobbies") {
        return { sufficient: true, extracted_value: `value-${node.field}`, message: "ack" };
      }
      hobbyTurns += 1;
      return {
        sufficient: true,
        extracted_value: hobbyTurns === 1 ? first : [{ name: "cooking" }],
        message: "ack-hobbies",
      };
    };
    return { run, asked: () => hobbyTurns };
  }

  it("persists a name-only list extracted from a multi-select answer", async () => {
    const { persist, calls } = makePersist();
    const { run } = softWithHobbies([{ name: "cooking" }, { name: "hiking" }]);
    const engine = new InterviewEngine("u1", {
      language: "en",
      tree: hobbyTree,
      runSoftTurn: run,
      persist,
    });

    await engine.handleMessage("start");
    const saved = await driveToCompletion(engine, calls);

    expect(saved.hobbies).toEqual([{ name: "cooking" }, { name: "hiking" }]);
  });

  it("re-asks instead of saving [] when extraction returns a malformed shape", async () => {
    const { persist, calls } = makePersist();
    // The exact shape observed in the wild: bare strings rather than objects.
    const { run, asked } = softWithHobbies(["cooking", "films"]);
    const engine = new InterviewEngine("u1", {
      language: "en",
      tree: hobbyTree,
      runSoftTurn: run,
      persist,
    });

    await engine.handleMessage("start");
    const saved = await driveToCompletion(engine, calls);

    expect(asked()).toBeGreaterThan(1); // the question came back round
    expect(saved.hobbies).toEqual([{ name: "cooking" }]); // the re-ask's answer, not []
  });

  it("re-asks when extraction returns nothing at all", async () => {
    const { persist, calls } = makePersist();
    const { run, asked } = softWithHobbies(undefined);
    const engine = new InterviewEngine("u1", {
      language: "en",
      tree: hobbyTree,
      runSoftTurn: run,
      persist,
    });

    await engine.handleMessage("start");
    const saved = await driveToCompletion(engine, calls);

    expect(asked()).toBeGreaterThan(1);
    expect(saved.hobbies).toEqual([{ name: "cooking" }]);
  });

  // The other half of the fix: a user who genuinely has nothing to list must
  // still be able to finish, and that empty list must be reached deliberately
  // (an explicit skip) rather than by an extraction failure defaulting into it.
  it("saves an empty list — without re-asking — when the user skips the question", async () => {
    const { persist, calls } = makePersist();
    const { run, asked } = softWithHobbies([{ name: "cooking" }]);
    const engine = new InterviewEngine("u1", {
      language: "en",
      tree: hobbyTree,
      runSoftTurn: run,
      persist,
    });

    await engine.handleMessage("start"); // greeting + hobbies question
    await engine.handleMessage("skip");
    const saved = await driveToCompletion(engine, calls);

    expect(saved.hobbies).toEqual([]);
    expect(asked()).toBe(0); // skipped outright — the model was never consulted
  });
});

// #488 — the engine keeps a write-only record of the interview so a wrong
// extraction can be read back against what the user actually said. ADR-0004's
// "no transcript replay" still holds: nothing here is ever fed to a model.
describe("InterviewEngine — transcript recording (#488)", () => {
  const transcriptTree: QuestionNode[] = [
    { field: "job", bucket: 1, text: "What do you do?", kind: "soft" },
    ...requiredFacts,
  ];

  it("persists a non-empty transcript pairing every question with its answer", async () => {
    const { persist, calls, transcripts } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      tree: transcriptTree,
      runSoftTurn: softAlwaysSufficient({}),
      persist,
    });

    await engine.handleMessage("start");
    await engine.handleMessage("I design apps.");
    await driveToCompletion(engine, calls);

    const transcript = transcripts[0];
    expect(transcript).not.toBe("");
    // Barney's opening question and the user's answer to it both survive, in order.
    expect(transcript).toContain("Barney: ");
    expect(transcript).toContain("User: I design apps.");
    expect(transcript.indexOf("What do you do?")).toBeLessThan(
      transcript.indexOf("User: I design apps.")
    );
    // The priming first call's input is not an answer and is never recorded.
    expect(transcript).not.toContain("User: start");
  });

  it("records probes and re-asks, not just the answers that landed", async () => {
    const { persist, calls, transcripts } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      tree: requiredFacts,
      runSoftTurn: softAlwaysSufficient({}),
      persist,
    });

    await engine.handleMessage("start");
    await engine.handleMessage("nope"); // no digits — probes "I need a number."
    await driveToCompletion(engine, calls);

    const transcript = transcripts[0];
    expect(transcript).toContain("User: nope");
    expect(transcript).toContain("Barney: I need a number.");
  });

  it("records a 'back' navigation and the answer that replaced the first one", async () => {
    const { persist, calls, transcripts } = makePersist();
    const engine = new InterviewEngine("u1", {
      language: "en",
      tree: [{ field: "job", bucket: 1, text: "What do you do?", kind: "soft" }, ...requiredFacts],
      runSoftTurn: softAlwaysSufficient({}),
      persist,
    });

    await engine.handleMessage("start");
    await engine.handleMessage("I design apps.");
    await engine.handleMessage("back");
    await engine.handleMessage("Actually, I teach.");
    await driveToCompletion(engine, calls);

    const transcript = transcripts[0];
    // Both the abandoned answer and its replacement are visible — that is the
    // point of a record, as opposed to the collected profile.
    expect(transcript).toContain("User: I design apps.");
    expect(transcript).toContain("User: back");
    expect(transcript).toContain("User: Actually, I teach.");
  });
});
