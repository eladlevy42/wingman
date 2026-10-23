import { prisma } from "@wingman/database";
import { UserProfileSchema, Track3ResultSchema } from "@wingman/shared";
import type { Track3Result, Track3FieldResult, UserProfile } from "@wingman/shared";
import { BarneyAgent } from "../../agents/barney.agent";
import { EVAL_MODEL_IDS } from "../../agents/models";
import { sample } from "./sample";
import type { EvalRunContext } from "./types";

// Order-independent structural equality — hobbies is an array of objects, so
// a plain JSON.stringify comparison would false-negative on key reordering
// the model is free to produce.
function fieldsMatch(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return false;
    return (
      expected.length === actual.length &&
      expected.every((value, index) => fieldsMatch(value, actual[index]))
    );
  }

  if (
    expected !== null &&
    actual !== null &&
    typeof expected === "object" &&
    typeof actual === "object"
  ) {
    const expectedKeys = Object.keys(expected as Record<string, unknown>);
    const actualKeys = Object.keys(actual as Record<string, unknown>);
    return (
      expectedKeys.length === actualKeys.length &&
      expectedKeys.every((key) =>
        fieldsMatch(
          (expected as Record<string, unknown>)[key],
          (actual as Record<string, unknown>)[key]
        )
      )
    );
  }

  return false;
}

// Appended to a replayed transcript so extraction calls saveProfile.
// The note's wording is redacted in the public showcase version.
const TRANSCRIPT_COMPLETE_NOTE =
  "\n\n[SYSTEM NOTE: Prompt redacted in the public showcase version. Call saveProfile.]";

// Replays the whole rawTranscript (plus TRANSCRIPT_COMPLETE_NOTE) as a single
// BarneyAgent turn in interview_self mode. See issue #86 and docs/adr/0011
// (stateless-per-call).
async function extractProfile(
  userId: string,
  rawTranscript: string,
  model: string
): Promise<{ profile: UserProfile | undefined; costUsd: number; durationMs: number }> {
  const agent = new BarneyAgent("interview_self", userId, undefined, undefined, model);
  let extracted: UserProfile | undefined;
  agent.on("toolCall", (event) => {
    if (event.name === "saveProfile") {
      extracted = event.input as UserProfile;
    }
  });
  await agent.sendMessage(rawTranscript + TRANSCRIPT_COMPLETE_NOTE);
  return { profile: extracted, ...agent.getUsage() };
}

// extractProfile drives the real saveProfile tool (see createSaveProfileTool
// in tools/saveProfile.ts), which upserts the userId's actual Profile row as
// a side effect. Left alone, that would overwrite the seeded ground-truth
// Profile with the model's own (possibly wrong) extraction — corrupting data
// Track 1 and the matching engine also read. Snapshot the row beforehand and
// restore it afterward so runTrack3 is read-only from the outside no matter
// what the agent does mid-run.
async function withProfileSnapshot<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const before = await prisma.profile.findUnique({ where: { userId } });
  try {
    return await fn();
  } finally {
    if (before) {
      await prisma.profile.update({
        where: { userId },
        data: {
          rawTranscript: before.rawTranscript,
          structuredData: before.structuredData,
          status: before.status,
        },
      });
    } else {
      await prisma.profile.deleteMany({ where: { userId } });
    }
  }
}

export async function runTrack3(ctx: EvalRunContext): Promise<Track3Result> {
  const seedTranscripts = await prisma.seedTranscript.findMany();
  const selected = sample(seedTranscripts, ctx.config.count, ctx.config.seed);
  const model = EVAL_MODEL_IDS[ctx.config.barneyModel];

  const results: Track3Result = [];

  for (let i = 0; i < selected.length; i++) {
    if (ctx.shouldStop()) break;
    const seedTranscript = selected[i];

    const expected = UserProfileSchema.parse(JSON.parse(seedTranscript.expectedStructuredProfile));
    const {
      profile: actual,
      costUsd,
      durationMs,
    } = await withProfileSnapshot(seedTranscript.userId, () =>
      extractProfile(seedTranscript.userId, seedTranscript.rawTranscript, model)
    );

    const fields: Track3FieldResult[] = [];
    let matchCount = 0;
    for (const field of Object.keys(expected) as (keyof UserProfile)[]) {
      const expectedValue = expected[field];
      const actualValue = actual ? actual[field] : undefined;
      const match = fieldsMatch(expectedValue, actualValue);
      if (match) matchCount++;
      fields.push({ field, expected: expectedValue, actual: actualValue, match });
    }

    results.push({
      userId: seedTranscript.userId,
      transcriptId: seedTranscript.id,
      fields,
      matchCount,
      fieldCount: fields.length,
      costUsd,
      durationMs,
    });
    ctx.onCase({
      index: i + 1,
      total: selected.length,
      costUsd,
      durationMs,
      score: fields.length > 0 ? matchCount / fields.length : 0,
      summary: `${matchCount}/${fields.length} fields matched`,
    });
  }

  return Track3ResultSchema.parse(results);
}
