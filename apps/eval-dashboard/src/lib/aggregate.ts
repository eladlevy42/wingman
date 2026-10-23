import type {
  EvalTrack,
  EvalResult,
  Track1Result,
  Track2Result,
  Track3Result,
} from "@wingman/shared";
import { scoreForCase } from "@/components/CaseCard";

// Mirrors each track's own aggregate stat where one already exists
// (Track 1's meanPrecision); computed on the fly for Track 2/3 from the same
// per-case score formula CaseCard uses, so history/diff numbers always agree
// with what the accordion cards show.
export function aggregateScore(track: EvalTrack, result: EvalResult | null): number | null {
  if (!result) return null;

  if (track === 1) return (result as Track1Result).meanPrecision;

  const rows = result as Track2Result | Track3Result;
  if (rows.length === 0) return null;
  const sum = rows.reduce((total, row) => total + scoreForCase(track, row), 0);
  return sum / rows.length;
}

export function caseCount(track: EvalTrack, result: EvalResult | null): number {
  if (!result) return 0;
  if (track === 1) return (result as Track1Result).perUser.length;
  return (result as Track2Result | Track3Result).length;
}

// Count of Track 2 pairs where the Dealbreaker Gate consistency judge (#337)
// flagged either side's self-score as inconsistent with what the transcript
// actually said. null for tracks/results with no such judge pass, so callers
// can distinguish "not applicable" from "zero found".
export function inconsistentCount(track: EvalTrack, result: EvalResult | null): number | null {
  if (track !== 2 || !result) return null;
  const rows = result as Track2Result;
  return rows.filter(
    (row) =>
      row.dealbreakerConsistency !== null &&
      (!row.dealbreakerConsistency.aConsistent || !row.dealbreakerConsistency.bConsistent)
  ).length;
}

// Track 2's headline accuracy metric (issue #398): the share of pairs whose
// engine outcome landed in the golden category's band. Replaces the old
// per-side meanAbsDelta point-target metric, which conflated within-band label
// noise and A/B score asymmetry. Null for non-Track-2 runs or pre-#398 runs
// where no pair recorded a `bandAgreement` verdict.
export function bandAgreementRate(track: EvalTrack, result: EvalResult | null): number | null {
  if (track !== 2 || !result) return null;
  const rows = (result as Track2Result).filter((row) => row.bandAgreement != null);
  if (rows.length === 0) return null;
  const inBand = rows.filter((row) => row.bandAgreement === true).length;
  return inBand / rows.length;
}

// Per-run share of factual claims the groundedness judge flagged as unsupported
// by the speaking agent's own profile (issue #336) — summed across every pair's
// both-speaker verdicts, so the run-level number agrees with the per-case flags.
// Null when the run isn't Track 2 or no pair recorded a groundedness verdict
// (e.g. pre-#336 runs); returns 0 when verdicts exist but counted no claims.
export function ungroundedRate(track: EvalTrack, result: EvalResult | null): number | null {
  if (track !== 2 || !result) return null;
  const rows = (result as Track2Result).filter((row) => row.groundedness !== null);
  if (rows.length === 0) return null;
  const totals = rows.reduce(
    (acc, row) => {
      const g = row.groundedness!;
      return { total: acc.total + g.totalClaims, ungrounded: acc.ungrounded + g.ungroundedCount };
    },
    { total: 0, ungrounded: 0 }
  );
  return totals.total > 0 ? totals.ungrounded / totals.total : 0;
}
