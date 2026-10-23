import { prisma, DELETED_USER_ID } from "@wingman/database";
import {
  UserProfileSchema,
  WantedProfileSchema,
  resolveCity,
  haversineDistanceKm,
} from "@wingman/shared";
import type {
  UserProfile,
  WantedProfile,
  CandidateScore,
  CandidateFailureReason,
  RankingSignals,
} from "@wingman/shared";
import { canonicalizeTerm } from "../lib/termNormalize";

type Candidate = {
  id: string;
  gender: string;
  profile: UserProfile;
  wantedProfile: WantedProfile;
};

function parseCandidate(user: {
  id: string;
  gender: string;
  profile: { structuredData: string | null } | null;
  wantedProfile: { structuredData: string | null } | null;
}): Candidate | null {
  if (!user.profile?.structuredData || !user.wantedProfile?.structuredData) return null;

  let profileJson: unknown;
  let wantedProfileJson: unknown;
  try {
    profileJson = JSON.parse(user.profile.structuredData);
    wantedProfileJson = JSON.parse(user.wantedProfile.structuredData);
  } catch {
    return null;
  }

  const profileResult = UserProfileSchema.safeParse(profileJson);
  const wantedProfileResult = WantedProfileSchema.safeParse(wantedProfileJson);
  if (!profileResult.success || !wantedProfileResult.success) return null;

  return {
    id: user.id,
    gender: user.gender,
    profile: profileResult.data,
    wantedProfile: wantedProfileResult.data,
  };
}

// Hard criteria per docs/adr/0006: genderPreference, ageRange, maxDistanceKm only —
// dealbreakers/preferences/compromises are Step 2 (agent negotiation) inputs, never
// consulted here. Returns the first criterion that fails, or null if `seeker`
// finds `other` acceptable (the reverse direction is a separate check — see
// mutualFailureReason).
// Distance between two candidates' cities, plus whether it's trustworthy.
// `unknown` is true when at least one city couldn't be located (#331): both
// then fall back to Tel Aviv, so `km` would read as 0 and is meaningless. The
// gate skips the distance check for unknown pairs and the ranking sorts them
// worst on the tie-break, so an unlocatable city never masquerades as "closest".
function cityDistance(a: Candidate, b: Candidate): { km: number; unknown: boolean } {
  const locA = resolveCity(a.profile.city);
  const locB = resolveCity(b.profile.city);
  return { km: haversineDistanceKm(locA, locB), unknown: !locA.known || !locB.known };
}

// One-directional gender acceptability: does `seeker`'s genderPreference admit
// `other`? Lifted into its own helper (#379) so `hardCriteriaFailure` and
// `bestAvailableCandidateId` share a single source of truth instead of the
// fallback inferring the rule by checking whether hardCriteriaFailure's
// returned code happens to equal "gender" — which only worked because gender
// happens to be checked first there.
function genderAcceptable(seeker: Candidate, other: Candidate): boolean {
  return (
    seeker.wantedProfile.genderPreference === "both" ||
    seeker.wantedProfile.genderPreference === other.gender
  );
}

function hardCriteriaFailure(seeker: Candidate, other: Candidate): CandidateFailureReason | null {
  if (!genderAcceptable(seeker, other)) return "gender";

  const { min, max } = seeker.wantedProfile.ageRange;
  if (other.profile.age < min || other.profile.age > max) return "age";

  // Only enforce the distance gate when both cities are known. An unlocatable
  // city can't be reliably distance-checked, so it passes the gate rather than
  // being rejected (or wrongly admitted) on a fabricated Tel Aviv coordinate.
  const distance = cityDistance(seeker, other);
  if (!distance.unknown && distance.km > seeker.wantedProfile.maxDistanceKm) return "distance";

  return null;
}

// Mutual: both `seeker` must want `other`, and `other` must want `seeker`.
// Reports whichever direction fails first (seeker's own check, then the
// reverse) — for a dev diagnostic this is enough to explain the rejection
// without needing to represent "failed in the other direction" separately.
function mutualFailureReason(a: Candidate, b: Candidate): CandidateFailureReason | null {
  return hardCriteriaFailure(a, b) ?? hardCriteriaFailure(b, a);
}

// Proprietary ranking is omitted in the public showcase version.
// Placeholder: 1 when the pair shares at least one hobby name after
// lowercasing and trimming, otherwise 0. Other signals stay at 0.
export const RANKING_WEIGHTS = {
  hobbyOverlap: 1,
  personalityOverlap: 0,
  socialEnergyCompatible: 0,
  kidsAligned: 0,
  kidsClash: 0,
} as const;

export const MIN_SHORTLIST_SCORE = 0;

function sharedTermCount(a: string[], b: string[]): number {
  const aTerms = new Set(a.map(canonicalizeTerm));
  const bTerms = new Set(b.map(canonicalizeTerm));
  let count = 0;
  for (const term of bTerms) {
    if (aTerms.has(term)) count += 1;
  }
  return count;
}

function rankingSignals(
  seeker: Candidate,
  other: Candidate,
  distance: { km: number; unknown: boolean }
): RankingSignals {
  const shared = sharedTermCount(
    seeker.profile.hobbies.map((h) => h.name),
    other.profile.hobbies.map((h) => h.name)
  );
  return {
    hobbies: shared > 0 ? RANKING_WEIGHTS.hobbyOverlap : 0,
    personality: 0,
    socialEnergy: 0,
    kids: 0,
    distanceKm: distance.km,
    distanceUnknown: distance.unknown,
  };
}

function totalScore(signals: RankingSignals): number {
  return signals.hobbies + signals.personality + signals.socialEnergy + signals.kids;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// How long a REJECTED negotiation keeps a pair off this seeker's shortlist
// (#344). Re-negotiating a known-rejected pair while nothing relevant changed
// is pure recurring API waste, so we skip it — but only for a window, since
// profiles and feedback (#299) evolve and can make a re-negotiation worthwhile
// later. Configurable via REJECTION_EXCLUSION_DAYS; defaults to 7 days. Only
// exactly 0 disables the exclusion — a negative or unparseable value warns and
// falls back to the 7-day default rather than disabling it (#377).
export function rejectionExclusionMs(): number {
  const raw = process.env.REJECTION_EXCLUSION_DAYS;
  if (raw === undefined || raw.trim() === "") return 7 * MS_PER_DAY;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) {
    console.warn(`matching: invalid REJECTION_EXCLUSION_DAYS="${raw}", falling back to 7 days`);
    return 7 * MS_PER_DAY;
  }
  return days * MS_PER_DAY;
}

// Candidate ids this seeker's agent negotiation rejected within the exclusion
// window (#344). REJECTED Match rows already record every turned-down pair, so
// the shortlist consults them to avoid re-running the same doomed negotiation.
// The seeker can be userA or userB on the Match, so we collect the *other*
// participant from either side. Returns an empty set when the window is
// disabled (rejectionExclusionMs() === 0), so no query runs in that case.
export async function recentlyRejectedCandidateIds(userId: string): Promise<Set<string>> {
  const windowMs = rejectionExclusionMs();
  if (windowMs === 0) return new Set();

  const since = new Date(Date.now() - windowMs);
  const rejected = await prisma.match.findMany({
    where: {
      status: "REJECTED",
      createdAt: { gte: since },
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    select: { userAId: true, userBId: true },
  });

  const excluded = new Set<string>();
  for (const m of rejected) {
    excluded.add(m.userAId === userId ? m.userBId : m.userAId);
  }
  return excluded;
}

// Candidate ids this seeker has ever completed a match with (#375). A
// completed Match row keeps status "MATCHED" forever, even after both users
// debrief back to WAITING, so this is a permanent exclusion — deliberately
// separate from recentlyRejectedCandidateIds's time-boxed window, since
// re-pairing a couple after a real date is not something to silently retry.
export async function previouslyMatchedCandidateIds(userId: string): Promise<Set<string>> {
  const matched = await prisma.match.findMany({
    where: {
      status: "MATCHED",
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    select: { userAId: true, userBId: true },
  });

  const excluded = new Set<string>();
  for (const m of matched) {
    excluded.add(m.userAId === userId ? m.userBId : m.userAId);
  }
  return excluded;
}

// Scores every WAITING candidate against `userId` — the full diagnostic pool
// deterministicFilter below reduces to a top-5 shortlist. Persisted verbatim
// per match attempt (issue #253) so the dev pipeline page can show not just
// who was shortlisted, but why everyone else wasn't.
export async function scoreCandidates(userId: string): Promise<CandidateScore[]> {
  const seekerRow = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true, wantedProfile: true },
  });
  const seeker = seekerRow && parseCandidate(seekerRow);
  if (!seeker) return [];

  // The tombstone (docs/adr/0040) is excluded by id rather than left to
  // parseCandidate's incomplete-profile path, which would keep a deleted account
  // in the diagnostic pool the #253 audit page renders.
  const candidateRows = await prisma.user.findMany({
    where: { matchingState: "WAITING", id: { notIn: [userId, DELETED_USER_ID] } },
    include: { profile: true, wantedProfile: true },
  });

  // Pairs this seeker's agent negotiation recently rejected (#344) — kept in
  // the diagnostic pool with a "recently_rejected" reason (so the #253 audit
  // still shows them) but excluded from the negotiated shortlist below.
  // Pairs this seeker has already completed a match (and been on a date)
  // with (#375) — permanent, checked ahead of recentlyRejected since it's the
  // stronger exclusion and doesn't depend on rejectionExclusionMs.
  // The two exclusion lookups are independent, so run them concurrently.
  const [recentlyRejected, previouslyMatched] = await Promise.all([
    recentlyRejectedCandidateIds(userId),
    previouslyMatchedCandidateIds(userId),
  ]);

  const scored: CandidateScore[] = candidateRows.map((row) => {
    const candidate = parseCandidate(row);
    if (!candidate) {
      return {
        candidateId: row.id,
        passedHardCriteria: false,
        failureReason: "incomplete_profile",
        overlapScore: null,
        rank: null,
        signals: null,
      };
    }

    if (previouslyMatched.has(candidate.id)) {
      return {
        candidateId: candidate.id,
        passedHardCriteria: false,
        failureReason: "already_matched",
        overlapScore: null,
        rank: null,
        signals: null,
      };
    }

    if (recentlyRejected.has(candidate.id)) {
      return {
        candidateId: candidate.id,
        passedHardCriteria: false,
        failureReason: "recently_rejected",
        overlapScore: null,
        rank: null,
        signals: null,
      };
    }

    const failureReason = mutualFailureReason(seeker, candidate);
    const passed = failureReason === null;
    const signals = passed
      ? rankingSignals(seeker, candidate, cityDistance(seeker, candidate))
      : null;
    return {
      candidateId: candidate.id,
      passedHardCriteria: passed,
      failureReason,
      overlapScore: signals ? totalScore(signals) : null,
      rank: null,
      signals,
    };
  });

  // Deterministic ranking (docs/adr/0023): weighted score descending, then
  // distance ascending, then candidate id — never database row order. The
  // MIN_SHORTLIST_SCORE floor (#334) keeps zero-overlap candidates off the
  // negotiated shortlist while leaving them in `scored` with rank: null, same
  // as any other candidate that passed hard criteria but missed the top 5.
  scored
    .filter((s) => s.passedHardCriteria && (s.overlapScore ?? 0) > MIN_SHORTLIST_SCORE)
    .sort(
      (a, b) =>
        (b.overlapScore ?? 0) - (a.overlapScore ?? 0) ||
        // Known-distance pairs sort ahead of unknown-distance pairs (#331), so
        // an unlocatable city never wins the tie-break by faking 0 km.
        Number(a.signals?.distanceUnknown ?? false) - Number(b.signals?.distanceUnknown ?? false) ||
        (a.signals?.distanceKm ?? 0) - (b.signals?.distanceKm ?? 0) ||
        a.candidateId.localeCompare(b.candidateId)
    )
    .slice(0, 5)
    .forEach((s, index) => {
      s.rank = index;
    });

  return scored;
}

export async function deterministicFilter(userId: string): Promise<string[]> {
  const scored = await scoreCandidates(userId);
  return scored
    .filter((s): s is CandidateScore & { rank: number } => s.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((s) => s.candidateId);
}

// Best-available fallback for the "always return a match" guarantee (#chat-flow
// #8). Unlike deterministicFilter, this deliberately ignores the hard criteria
// (gender/age/distance) so it never comes back empty when anyone else is waiting
// — but it still ranks sensibly so the closest fit wins: a candidate whose
// gender is mutually acceptable (the seeker wants their gender AND they want the
// seeker's) outranks a one-directional match, which in turn outranks neither;
// then more shared hobbies, then nearer. Preferring rather than requiring
// mutuality preserves the guarantee — a mutually-incompatible pair is only
// returned when it is the sole option. Returns the single best candidate id, or
// null only when there is genuinely no other waiting, fully-profiled user to
// pair with.
// excludeIds lets callers keep this fallback from re-proposing a candidate
// already tried (and rejected) earlier in the same matching cycle.
//
// respectRejectionWindow (#374) additionally excludes candidates this seeker's
// agent negotiation rejected within the #344 window (same source as
// scoreCandidates' "recently_rejected" reason), so the automatic sweep's
// fallback can't force-pair a couple the agents turned down within the
// configured rejection window (the #344 default, ~7 days). Defaults to true.
// The manual guaranteeMatch last-resort pass in
// orchestration.service.ts deliberately passes false to re-admit those
// candidates as the documented final option — that bypass must stay an
// explicit, commented choice at the call site, never this function's default.
export async function bestAvailableCandidateId(
  userId: string,
  excludeIds: ReadonlySet<string> = new Set(),
  {
    respectRejectionWindow = true,
    recentlyRejectedIds,
    previouslyMatchedIds,
  }: {
    respectRejectionWindow?: boolean;
    recentlyRejectedIds?: ReadonlySet<string>;
    previouslyMatchedIds?: ReadonlySet<string>;
  } = {}
): Promise<string | null> {
  const seekerRow = await prisma.user.findUnique({
    where: { id: userId },
    include: { profile: true, wantedProfile: true },
  });
  const seeker = seekerRow && parseCandidate(seekerRow);
  if (!seeker) return null;

  // Callers that invoke this repeatedly in a loop (forceBestAvailable) can pass
  // precomputed recentlyRejectedIds / previouslyMatchedIds sets to avoid
  // re-querying them every iteration — neither can change mid-call. Falls back
  // to querying when not supplied.
  const recentlyRejected = respectRejectionWindow
    ? (recentlyRejectedIds ?? (await recentlyRejectedCandidateIds(userId)))
    : new Set<string>();

  // Previously-matched pairs (#375) are excluded from the fallback the same
  // way an already-tried-this-cycle candidate is: folded into excludeIds so
  // the "always return a match" guarantee never re-proposes someone this
  // seeker already went on a date with. The #374 recently-rejected window is
  // folded into the same notIn so both exclusions happen in the DB query.
  const previouslyMatched = previouslyMatchedIds ?? (await previouslyMatchedCandidateIds(userId));
  const allExcludeIds = new Set([...excludeIds, ...previouslyMatched, ...recentlyRejected]);

  const candidateRows = await prisma.user.findMany({
    where: {
      matchingState: "WAITING",
      // The tombstone joins the exclusion list rather than relying on IDLE
      // (docs/adr/0040) — this is the "always return a match" fallback, the one
      // path that most wants a candidate.
      id: { notIn: [userId, ...allExcludeIds, DELETED_USER_ID] },
    },
    include: { profile: true, wantedProfile: true },
  });
  const candidates = candidateRows.map(parseCandidate).filter((c): c is Candidate => c !== null);
  if (candidates.length === 0) return null;

  const ranked = candidates
    .map((c) => {
      const distance = cityDistance(seeker, c);
      // Mutual gender acceptability: the seeker wants the candidate's gender AND
      // the candidate wants the seeker's. Uses the same genderAcceptable helper
      // hardCriteriaFailure's gender check does (#379), rather than inferring it
      // from hardCriteriaFailure's returned failure code.
      const seekerWantsCandidate = genderAcceptable(seeker, c);
      const candidateWantsSeeker = genderAcceptable(c, seeker);
      return {
        id: c.id,
        // 2 = mutually acceptable, 1 = one-directional, 0 = neither.
        genderRank: (seekerWantsCandidate ? 1 : 0) + (candidateWantsSeeker ? 1 : 0),
        // Showcase placeholder score. Proprietary ranking is omitted.
        score: totalScore(rankingSignals(seeker, c, distance)),
        distanceKm: distance.km,
        distanceUnknown: distance.unknown,
      };
    })
    .sort((a, b) => {
      if (a.genderRank !== b.genderRank) return b.genderRank - a.genderRank;
      if (b.score !== a.score) return b.score - a.score;
      if (a.distanceUnknown !== b.distanceUnknown) return a.distanceUnknown ? 1 : -1;
      return a.distanceKm - b.distanceKm || a.id.localeCompare(b.id);
    });

  return ranked[0].id;
}
