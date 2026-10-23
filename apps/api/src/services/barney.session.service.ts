import { randomUUID } from "node:crypto";
import { prisma } from "@wingman/database";
import { BarneySessionInputSchema, UserProfileSchema } from "@wingman/shared";
import type { BarneySessionResponse, UserProfile } from "@wingman/shared";
import { BarneyAgent } from "../agents/barney.agent";
import { InterviewEngine } from "../agents/interview/interview.engine";
import { addressFormForGender } from "../agents/interview/localized";
import { createWarmSoftTurn } from "../agents/interview/softTurn";
import type { InterviewMode } from "../agents/interview/interview.config";
import { getMatchById, MatchNotFoundError, MatchOwnershipError } from "./match.service";
import { sessions, sweepExpired } from "./barney.sessionRegistry";
import type { Session } from "./barney.sessionRegistry";
import { loadInterviewSnapshot } from "./interviewSnapshot.service";
import type { BarneyMode } from "@wingman/shared";

// Re-exported for existing importers (routes, tests) — the canonical
// definitions live in match.service.ts, which this module already depends on.
export { MatchNotFoundError, MatchOwnershipError };

// MatchNotFoundError is thrown for an unknown matchId, and also for a matchId
// whose rationale is null — a null rationale means the match was actually
// rejected (see docs/adr/0010), so a pitch request against it is invalid the
// same way an unknown matchId is (docs/adr/0014). Both map to 404 in the
// route. MatchOwnershipError is thrown when the requesting userId is not a
// participant (userAId/userBId) in the given match, and maps to 403.

// Modes driven by the deterministic InterviewEngine (ADR 0004) rather than the
// free-form BarneyAgent. Both interview phases run on the engine; pitch/debrief
// stay on BarneyAgent permanently — they are open-ended negotiations with no
// question tree.
const ENGINE_MODES = new Set<BarneyMode>(["interview_self", "interview_wants"]);

export async function createSession(input: unknown): Promise<BarneySessionResponse> {
  const { userId, mode, matchId, language } = BarneySessionInputSchema.parse(input);
  const now = Date.now();
  sweepExpired(now);

  const sessionId = randomUUID();
  if (ENGINE_MODES.has(mode)) {
    // Safe narrowing: ENGINE_MODES only ever holds the two interview modes.
    const interviewMode = mode as InterviewMode;
    // One warm soft-turn session per interview: the ~9-15s Agent SDK subprocess
    // spawn is paid once, then every later soft turn reuses the live subprocess
    // (~1s). See #246. prewarm() below kicks that spawn off eagerly — right now,
    // at session creation — so it overlaps the seconds the user spends answering
    // the instant deterministic fact questions (age/city/...), which never hit
    // the model. By the time the first soft node is reached, the subprocess is
    // (usually) already warm, so the first soft turn drops from ~15s to model-
    // generation only (measured live: 6.5s -> 1.4s). See #249.
    //
    // The SDK emits nothing until it receives input, so paying the spawn early
    // requires one cheap throwaway warm-up turn (its reply is discarded) — a
    // deliberate, documented tradeoff, not a free spawn. See prewarm() in
    // agentSdkSession for the full rationale.
    const warm = createWarmSoftTurn({ userId });
    // Fire-and-forget and best-effort: prewarm never throws, and a failed warm-up
    // just means the first soft turn pays the spawn itself as before — so a warm
    // failure can never fail session creation or the interview (#249).
    warm.prewarm();
    // Registration collects gender before any interview, so Hebrew copy can
    // address the person directly (אתה/את) instead of the neutral plural. A
    // missing user or an "other" gender falls back to the plural.
    const user = await prisma.user.findUnique({ where: { id: userId } });
    sessions.set(sessionId, {
      kind: "engine",
      engine: new InterviewEngine(userId, {
        mode: interviewMode,
        runSoftTurn: warm.softTurn,
        // Undefined falls through to the engine's own default (Hebrew), so the
        // product default lives in exactly one place (ADR-0037).
        language,
        addressForm: addressFormForGender(user?.gender),
      }),
      mode: interviewMode,
      userId,
      lastAccessAt: now,
      closeWarm: warm.close,
      pendingTurns: new Map(),
    });
  } else if (mode === "pitch") {
    // Guaranteed present by BarneySessionInputSchema's refine.
    const match = await getMatchById(matchId as string);
    if (!match || !match.rationale) {
      throw new MatchNotFoundError(`No pitchable match found for id ${matchId}`);
    }
    if (match.userAId !== userId && match.userBId !== userId) {
      throw new MatchOwnershipError(`User ${userId} is not a participant in match ${matchId}`);
    }
    // Load the matched partner's profile so Barney can answer the user's 3
    // questions with real facts (hobbies, job, values), not just the rationale.
    // This supersedes the rationale-only design of docs/adr/0013 — see
    // docs/adr/0020. Identity (name/photo) is deliberately NOT injected: the
    // profile summary omits it, preserving the Blind Date reveal (docs/adr/0012).
    const partnerId = match.userAId === userId ? match.userBId : match.userAId;
    const partner = await prisma.user.findUnique({
      where: { id: partnerId },
      include: { profile: true },
    });
    sessions.set(sessionId, {
      kind: "agent",
      agent: new BarneyAgent(mode, userId, {
        RATIONALE_CONTEXT: match.rationale,
        MATCH_PROFILE: formatMatchProfile(partner?.profile?.structuredData ?? null, match.id),
      }),
      mode,
      userId,
      lastAccessAt: now,
      pendingTurns: new Map(),
    });
  } else if (mode === "debrief") {
    // Guaranteed present by BarneySessionInputSchema's refine.
    const match = await getMatchById(matchId as string);
    // A debrief is only valid once the Blind Date has actually happened —
    // venue/dateTime being set only means one was assigned (followup.service's
    // AWAITING_DATE), not that it occurred yet. Mirrors the same "has the date
    // passed" check processUserFollowUp uses to flip FollowUp to DATE_PASSED.
    if (!match || !match.venue || !match.dateTime || match.dateTime.getTime() > now) {
      throw new MatchNotFoundError(`No debriefable Blind Date found for match ${matchId}`);
    }
    if (match.userAId !== userId && match.userBId !== userId) {
      throw new MatchOwnershipError(`User ${userId} is not a participant in match ${matchId}`);
    }
    const partnerId = match.userAId === userId ? match.userBId : match.userAId;
    const partner = await prisma.user.findUnique({ where: { id: partnerId } });
    sessions.set(sessionId, {
      kind: "agent",
      agent: new BarneyAgent(
        mode,
        userId,
        {
          DATE_CONTEXT: formatDateContext(
            partner?.name ?? "your match",
            match.venue,
            match.dateTime
          ),
        },
        match.id
      ),
      mode,
      userId,
      matchId: match.id,
      lastAccessAt: now,
      pendingTurns: new Map(),
    });
  } else {
    sessions.set(sessionId, {
      kind: "agent",
      agent: new BarneyAgent(mode, userId),
      mode,
      userId,
      lastAccessAt: now,
      pendingTurns: new Map(),
    });
  }
  return { sessionId };
}

/**
 * Rebuilds an engine session from its database snapshot (#545) — the recovery
 * path for a sessionId the in-memory registry no longer knows (api restart, or
 * TTL eviction the snapshot outlived by seconds). Returns null when there is
 * nothing to rehydrate, and the caller falls through to SessionNotFoundError
 * exactly as before.
 *
 * Deliberately mirrors createSession's engine branch — same warm soft-turn,
 * same deps — and then restore()s the engine to the snapshotted turn. The
 * rebuilt session goes back into the registry under its original id, so the
 * client's held sessionId, its stored transcript, and its turnId replay all
 * keep working unchanged.
 */
export async function rehydrateEngineSession(
  sessionId: string,
  now: number
): Promise<Session | null> {
  const stored = await loadInterviewSnapshot(sessionId, now);
  if (!stored) return null;
  // The address form is a constructor dep, not snapshot state, so it is
  // re-derived from gender exactly as createSession does.
  const user = await prisma.user.findUnique({ where: { id: stored.userId } });

  // The DB reads above is an await, and the stream endpoint plus its
  // stream-drop fallback can both miss the registry for the same lost id at
  // once. Whoever finishes loading second must adopt the session the first
  // registered, not overwrite it — an overwrite would leak the first's warm
  // subprocess (closeWarm never called) and split the turnId dedup across two
  // engines, running the same answer twice.
  const raced = sessions.get(sessionId);
  if (raced) return raced;

  // See createSession above for why the warm soft-turn is prewarmed eagerly.
  // On this path the user is mid-interview, likely seconds from their next
  // soft turn, so overlapping the spawn with their typing matters even more.
  const warm = createWarmSoftTurn({ userId: stored.userId });
  warm.prewarm();
  const engine = new InterviewEngine(stored.userId, {
    mode: stored.mode,
    runSoftTurn: warm.softTurn,
    addressForm: addressFormForGender(user?.gender),
  });
  engine.restore(stored.state);

  const session: Session = {
    kind: "engine",
    engine,
    mode: stored.mode,
    userId: stored.userId,
    lastAccessAt: now,
    // Seeds the turnId-replay dedup with the last turn the old process
    // answered, so a client retrying that turn after the restart gets the
    // cached result instead of double-advancing the restored engine.
    lastTurn: stored.lastTurn,
    closeWarm: warm.close,
    pendingTurns: new Map(),
  };
  sessions.set(sessionId, session);
  return session;
}

// Fills PITCH_PROMPT's {{MATCH_PROFILE}} placeholder with a readable summary of
// the matched person's UserProfile (docs/adr/0020). Only fields that are
// actually present are listed, so a question about something the profile does
// not contain naturally maps to Barney's "I don't know" behavior (pitch rule 3).
// Identity fields (name, photoUrls) are intentionally excluded — the name is
// saved for the Blind Date reveal (docs/adr/0012), and the photo is shown by the
// app UI on the Pitch page, never voiced by Barney. A missing/malformed profile falls
// back to a neutral note so the pitch still runs on the rationale alone.
function formatMatchProfile(structuredData: string | null, matchId: string): string {
  if (!structuredData) {
    console.error(`pitch: match ${matchId} partner has no profile to summarize`);
    return "(No detailed profile is available — go on what the reasons above say.)";
  }
  let profile: UserProfile;
  try {
    profile = UserProfileSchema.parse(JSON.parse(structuredData));
  } catch (error) {
    console.error(`pitch: match ${matchId} partner profile failed to parse:`, error);
    return "(No detailed profile is available — go on what the reasons above say.)";
  }

  const lines: string[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value && value.trim()) lines.push(`- ${label}: ${value.trim()}`);
  };

  add("Age", profile.age ? String(profile.age) : null);
  add("Lives in", [profile.city, profile.country].filter(Boolean).join(", ") || null);
  add("Originally from", profile.hometown);
  add("Height", profile.height);
  add("Work", profile.job);
  add("Education", profile.education);
  add("How they handle conflict", profile.conflict_style);
  add("Emotional openness", profile.emotional_openness);
  add("How they treat people", profile.treatment_of_others);
  if (profile.wants_kids === true) add("Kids", "wants kids");
  else if (profile.wants_kids === false) add("Kids", "does not want kids");
  else if (profile.wants_kids === "undecided") add("Kids", "undecided about kids");
  add("Timeline for kids", profile.kids_timeline);
  add("Faith", profile.faith);
  add("What drives them right now", profile.current_motivation);
  add("Life vision", profile.life_vision);
  if (profile.hobbies.length > 0) {
    add("Hobbies", profile.hobbies.map((h) => h.name).join(", "));
  }
  add("Typical weekend", profile.typical_weekend);
  add("Social energy", profile.social_energy);
  add("Social circle", profile.social_circle);

  return lines.length > 0
    ? lines.join("\n")
    : "(No detailed profile is available — go on what the reasons above say.)";
}

// Fills DEBRIEF_PROMPT's {{DATE_CONTEXT}} placeholder — see
// apps/api/src/agents/prompts/debrief.ts for the exact sentence shape this
// feeds into.
function formatDateContext(partnerName: string, venue: string, dateTime: Date): string {
  const date = dateTime.toLocaleDateString("en-US");
  const time = dateTime.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `You went on a Blind Date with ${partnerName} at ${venue} on ${date} at ${time}.`;
}
