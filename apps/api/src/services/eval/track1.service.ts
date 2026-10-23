import { prisma, EXPECTED_MATCHES_PER_USER } from "@wingman/database";
import { ExpectedMatchesSchema, Track1ResultSchema } from "@wingman/shared";
import type { Track1Result } from "@wingman/shared";
import { deterministicFilter } from "../matching.service";
import { sample } from "./sample";
import type { EvalRunContext } from "./types";

const SEEDED_USER_COUNT = 500;

export class EvalPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalPreconditionError";
  }
}

export type { PerUserResult, Track1Result } from "@wingman/shared";

// Track 1 has no LLM-backed steps — every case's costUsd is 0 by
// construction; durationMs still reflects real DB round-trip time.
export async function runTrack1(ctx: EvalRunContext): Promise<Track1Result> {
  // Scoped to the archetype population Track 1 actually evaluates (users with
  // a non-null expectedMatches), not a raw WAITING count — seedFixtures()
  // always adds 2 more permanently-WAITING synthetic fixtures on top of the
  // 500 archetype users on every `pnpm db:seed` run, and those fixtures never
  // get an expectedMatches value, so a raw count is off by +2 on every normal
  // seed (#411).
  const seededCount = await prisma.user.count({
    where: { matchingState: "WAITING", expectedMatches: { not: null } },
  });

  if (seededCount !== SEEDED_USER_COUNT) {
    throw new EvalPreconditionError(
      `Eval requires exactly ${SEEDED_USER_COUNT} seeded WAITING users with expected matches — found ${seededCount}. Re-seed the database before running an Eval Run.`
    );
  }

  const users = await prisma.user.findMany({
    where: { expectedMatches: { not: null } },
    select: { id: true, expectedMatches: true },
  });
  const selected = sample(users, ctx.config.count, ctx.config.seed);

  const perUser: Track1Result["perUser"] = [];

  for (let i = 0; i < selected.length; i++) {
    if (ctx.shouldStop()) break;
    const user = selected[i];

    const start = Date.now();
    const expected = ExpectedMatchesSchema.parse(JSON.parse(user.expectedMatches!));
    const actual = await deterministicFilter(user.id);
    const durationMs = Date.now() - start;

    const hits = actual.filter((id) => expected.includes(id)).length;
    const precision = hits / EXPECTED_MATCHES_PER_USER;

    perUser.push({ userId: user.id, actual, expected, precision, costUsd: 0, durationMs });
    ctx.onCase({
      index: i + 1,
      total: selected.length,
      costUsd: 0,
      durationMs,
      score: precision,
      summary: `precision ${precision.toFixed(2)} (${hits}/${EXPECTED_MATCHES_PER_USER})`,
    });
  }

  const meanPrecision =
    perUser.length > 0 ? perUser.reduce((sum, r) => sum + r.precision, 0) / perUser.length : 0;

  return Track1ResultSchema.parse({ meanPrecision, perUser });
}
