import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  detectTurnViolations,
  CONTAMINATING_VIOLATION_KINDS,
} from "../../agents/negotiation.agent";
import type {
  NegotiationResult,
  GroundednessFlag,
  ConsistencyVerdict,
  Track2LogRecord,
  Track2RunLog,
} from "@wingman/shared";

export interface BuildLogInput {
  pair: { id: string; userAId: string; userBId: string; goldenScore: number; category: string };
  nameA: string;
  nameB: string;
  negotiation: NegotiationResult;
  groundednessA: GroundednessFlag[];
  groundednessB: GroundednessFlag[];
  totalClaims: number;
  consistency: ConsistencyVerdict | null;
  judgeScore: number | null;
  judgeRationale: string | null;
  deltaA: number;
  deltaB: number;
  bandAgreement?: boolean;
  // Per-side band verdicts (#422) — see Track2LogRecordSchema.outcome.
  bandAgreementA?: boolean;
  bandAgreementB?: boolean;
}

// Scans the final transcript for violations that survived the turn-level retry
// guard, keeping only the kinds `wanted` selects. Splitting one scan two ways
// (#422) is what lets the condemning flag and the annotating one stay separate
// without running the detector twice over the same text.
function survivingViolations(
  deliberationLog: NegotiationResult["deliberationLog"],
  wanted: (kind: string) => boolean
): { speaker: string; kinds: string[]; snippet: string }[] {
  return deliberationLog.flatMap((m) => {
    const kinds = detectTurnViolations(m.content).filter(wanted);
    return kinds.length > 0
      ? [{ speaker: m.speaker, kinds, snippet: m.content.replace(/\s+/g, " ").slice(0, 160) }]
      : [];
  });
}

// Pure: shape a single couple's audit record. No I/O, so it's unit-tested.
export function buildTrack2LogRecord(input: BuildLogInput): Track2LogRecord {
  return {
    couple: {
      pairId: input.pair.id,
      userAId: input.pair.userAId,
      userBId: input.pair.userBId,
      nameA: input.nameA,
      nameB: input.nameB,
      intendedGoldenScore: input.pair.goldenScore,
      category: input.pair.category,
    },
    conversation: input.negotiation.deliberationLog,
    scoreRationales: { a: input.negotiation.rationaleA, b: input.negotiation.rationaleB },
    lieFlags: { a: input.groundednessA, b: input.groundednessB, totalClaims: input.totalClaims },
    consistency: input.consistency,
    // Backstop for anything that slipped past the turn-level retry guard
    // (#420): scan the final transcript so a contaminated case (leaked score or
    // staged other-side turn) is flagged in the log for discarding. Split by
    // severity (#422) — only the CONTAMINATING kinds land here, keeping ADR
    // 0030's "non-empty means discard from calibration" rule meaning exactly
    // what it meant before staged-qa-exchange existed.
    protocolViolations: survivingViolations(input.negotiation.deliberationLog, (kind) =>
      CONTAMINATING_VIOLATION_KINDS.includes(kind)
    ),
    // The quiet half: annotates, never condemns. See the schema comment.
    quietViolations: survivingViolations(
      input.negotiation.deliberationLog,
      (kind) => !CONTAMINATING_VIOLATION_KINDS.includes(kind)
    ),
    // The guard re-asks that fired mid-negotiation (#422) — previously only
    // console.warn scrollback. `?? []` is defensive, not dead: the schema
    // defaults this field, but runNegotiation's debug-comparison path builds
    // its result through an unvalidated `as unknown as NegotiationResult` cast,
    // so a future edit there could hand us an object without it.
    guardRetries: input.negotiation.guardRetries ?? [],
    judge: { score: input.judgeScore, rationale: input.judgeRationale },
    outcome: {
      scoreA: input.negotiation.scoreA,
      scoreB: input.negotiation.scoreB,
      matched: input.negotiation.matched,
      deltaA: input.deltaA,
      deltaB: input.deltaB,
      bandAgreement: input.bandAgreement,
      bandAgreementA: input.bandAgreementA,
      bandAgreementB: input.bandAgreementB,
    },
  };
}

// Timestamped run file under docs/evidence/track2-eval-run/. Caller passes a
// filesystem-safe ISO stamp (Date.now is unavailable inside workflow scripts,
// but this runs in a normal Node process, so `new Date().toISOString()` is fine
// here). Returns the written path.
export async function writeTrack2Log(log: Track2RunLog, isoStamp: string): Promise<string> {
  const dir = join(process.cwd(), "..", "..", "docs", "evidence", "track2-eval-run");
  await mkdir(dir, { recursive: true });
  const safe = isoStamp.replace(/[:.]/g, "-");
  const suffix = log.meta.runIndex !== undefined ? `-run${log.meta.runIndex}` : "";
  const path = join(dir, `${safe}${suffix}.json`);
  await writeFile(path, JSON.stringify(log, null, 2), "utf8");
  return path;
}
