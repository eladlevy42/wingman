import type { z } from "zod";
import {
  UserProfileSchema,
  WantedProfileSchema,
  WINGMAN_COUNTRY,
  type UserProfile,
} from "@wingman/shared";
import { persistProfile } from "../tools/saveProfile";
import { persistWantedProfile } from "../tools/persistWantedProfile";
import {
  INTERVIEW_SELF_TREE,
  SELF_SECTIONS,
  type InterviewSectionDef,
  type QuestionNode,
} from "./questionTree";
import { INTERVIEW_WANTS_TREE } from "./wantsTree";
import type { Text } from "./localized";

// A config bundle is everything that differs between the two interview modes.
// The InterviewEngine core — tree walk, probe cap, re-ask safety net — is
// identical for both; only the tree, the greeting/closing copy, and how the
// collected answers become a validated, persisted profile change. See
// docs/adr/0004 point 7 ("built once and applied twice") and docs/adr/0005.

// Persists the assembled, already-validated profile along with the transcript
// of the interview that produced it (#488). Injectable so tests don't touch the DB.
export type PersistFn = (
  userId: string,
  profile: Record<string, unknown>,
  rawTranscript: string
) => Promise<void>;

export interface InterviewConfig {
  // The deterministic flow the engine walks.
  tree: QuestionNode[];
  // Ordered topic sections, mapped from the tree's bucket numbers, for the UI's
  // "Section N of M" header. Optional — a mode without sections (or a test tree)
  // simply reports no section. Currently only Phase 1 defines them.
  sections?: InterviewSectionDef[];
  // Barney's opening line, prepended to the first question.
  greeting: Text;
  // Barney's closing line, appended once the profile is locked in.
  closing: Text;
  // Validates the assembled object before persisting. A failure re-asks the
  // offending question instead of throwing.
  schema: z.ZodTypeAny;
  // Turns the flat `collected` bag (keyed by node.field) into the object that
  // `schema` validates. For self this is a straight key copy with null/empty
  // defaults; for wants it also folds ageMin/ageMax into the nested ageRange.
  assemble: (collected: Record<string, unknown>) => Record<string, unknown>;
  // Persists the validated profile.
  persist: PersistFn;
  // Maps a schema validation error path back to the tree field id to re-ask.
  // Defaults to the first path segment; wants overrides it for nested ageRange.
  errorPathToField: (path: (string | number)[]) => string;
}

// ---- Phase 1: interview_self -------------------------------------------------

const SELF_GREETING: Text = {
  en: "[redacted:en]",
  he: "[redacted:he]",
  heM: "[redacted:he-m]",
  heF: "[redacted:he-f]",
};
const SELF_CLOSING: Text = {
  en: "[redacted:en]",
  he: "[redacted:he]",
  heM: "[redacted:he-m]",
  heF: "[redacted:he-f]",
};

// Assembles a full UserProfile from what was collected. Every key is filled,
// defaulting to null, so a short/uncooperative interview still produces a
// schema-shaped object — validation is the real guarantee.
//
// `hobbies` is the one field that must NOT be defaulted into a schema-valid
// shape. An empty array used to validate and persist, so a failed extraction
// was stored with no re-ask. Only an explicit skip (recorded as `null`) becomes
// an empty list; a missing or malformed value is passed through so finalize()
// re-asks the question.
function assembleHobbies(collected: unknown): unknown {
  return collected === null ? [] : collected;
}
function assembleSelf(c: Record<string, unknown>): Record<string, unknown> {
  return {
    age: c.age ?? null,
    city: c.city ?? null,
    // Never collected — the country question was removed in #530 because
    // Wingman is Israel-only (registration is gated to Tel Aviv University
    // addresses). Filled here so the field stays populated for anything that
    // reads it, without spending an interview turn on a known answer.
    country: WINGMAN_COUNTRY,
    height: c.height ?? null,
    job: c.job ?? null,
    hometown: c.hometown ?? null,
    education: c.education ?? null,
    body_type: c.body_type ?? null,
    appearance: c.appearance ?? null,
    conflict_style: c.conflict_style ?? null,
    emotional_openness: c.emotional_openness ?? null,
    treatment_of_others: c.treatment_of_others ?? null,
    personality_traits: c.personality_traits ?? [],
    wants_kids: c.wants_kids ?? null,
    kids_timeline: c.kids_timeline ?? null,
    faith: c.faith ?? null,
    current_motivation: c.current_motivation ?? null,
    life_vision: c.life_vision ?? null,
    hobbies: assembleHobbies(c.hobbies),
    typical_weekend: c.typical_weekend ?? null,
    social_energy: c.social_energy ?? null,
    social_circle: c.social_circle ?? null,
    // Free-form note captured by the end-of-interview "anything else?" turn (#251).
    additionalNotes: c.additionalNotes ?? null,
  };
}

export const SELF_CONFIG: InterviewConfig = {
  tree: INTERVIEW_SELF_TREE,
  sections: SELF_SECTIONS,
  greeting: SELF_GREETING,
  closing: SELF_CLOSING,
  schema: UserProfileSchema,
  assemble: assembleSelf,
  // Reuses the saveProfile tool's validate-and-upsert logic — the single
  // source of truth for how a Phase-1 profile reaches the database. Returns a
  // receipt we don't need here.
  persist: async (userId, profile, rawTranscript) => {
    await persistProfile(userId, profile as UserProfile, rawTranscript);
  },
  errorPathToField: (path) => String(path[0]),
};

// ---- Phase 2: interview_wants ------------------------------------------------

const WANTS_GREETING: Text = {
  en: "[redacted:en]",
  he: "[redacted:he]",
  heM: "[redacted:he-m]",
  heF: "[redacted:he-f]",
};
const WANTS_CLOSING: Text = {
  en: "[redacted:en]",
  he: "[redacted:he]",
  heM: "[redacted:he-m]",
  heF: "[redacted:he-f]",
};

// The default distance recorded when the user expresses no distance preference.
const DEFAULT_MAX_DISTANCE_KM = 100;

// Folds the collected bag into the nested WantedProfile shape. ageMin/ageMax
// become ageRange{min,max}; maxDistanceKm falls back to the generous default;
// every list defaults to [].
function assembleWants(c: Record<string, unknown>): Record<string, unknown> {
  return {
    genderPreference: c.genderPreference ?? null,
    ageRange: { min: c.ageMin ?? null, max: c.ageMax ?? null },
    maxDistanceKm: c.maxDistanceKm ?? DEFAULT_MAX_DISTANCE_KM,
    appearance: c.appearance ?? [],
    personality: c.personality ?? [],
    lifestyle: c.lifestyle ?? [],
    dealbreakers: c.dealbreakers ?? [],
    preferences: c.preferences ?? [],
    compromises: c.compromises ?? [],
    // Free-form note captured by the end-of-interview "anything else?" turn (#251).
    additionalNotes: c.additionalNotes ?? null,
  };
}

export const WANTS_CONFIG: InterviewConfig = {
  tree: INTERVIEW_WANTS_TREE,
  greeting: WANTS_GREETING,
  closing: WANTS_CLOSING,
  schema: WantedProfileSchema,
  assemble: assembleWants,
  persist: async (userId, profile, rawTranscript) => {
    // persistWantedProfile also flips User.matchingState → WAITING in the same
    // transaction (ADR 0005); it returns a receipt we don't need here.
    await persistWantedProfile(userId, profile, rawTranscript);
  },
  // A validation failure on the nested ageRange (including the min<=max refine,
  // whose path is ["ageRange","max"]) must re-ask the flat ageMin/ageMax node,
  // not a non-existent "ageRange" node. Every other field id matches its node.
  errorPathToField: (path) => {
    if (path[0] === "ageRange") return path[1] === "min" ? "ageMin" : "ageMax";
    return String(path[0]);
  },
};

// The engine mode → config map. Only the two interview modes have a config;
// pitch/debrief run on BarneyAgent and never reach the engine.
export type InterviewMode = "interview_self" | "interview_wants";

export const CONFIG_BY_MODE: Record<InterviewMode, InterviewConfig> = {
  interview_self: SELF_CONFIG,
  interview_wants: WANTS_CONFIG,
};
