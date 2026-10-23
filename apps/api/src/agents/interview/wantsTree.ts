import {
  extractAge,
  extractPositiveInt,
  MIN_AGE,
  MAX_AGE,
  type QuestionNode,
} from "./questionTree";

// The deterministic interview flow for Phase 2 (interview_wants). See
// docs/adr/0004-deterministic-interview-engine.md and docs/adr/0005. Same engine,
// different tree/schema/persistence — supplied via the config bundle in
// interview.config.ts. The question text and probing rules mirror the reference
// material in agents/prompts/interview-wants.ts (that prompt is no longer a
// driver — the tree owns the flow, one Haiku call per soft turn owns the voice).

// The wants tree's collected field ids. These are NOT WantedProfile keys: the
// nested `ageRange { min, max }` is gathered as two flat fact nodes (ageMin,
// ageMax) that the wants config's assemble() folds into the nested shape. Every
// other id matches its schema key so assemble is a straight copy.
export type WantsField =
  | "genderPreference"
  | "ageMin"
  | "ageMax"
  | "maxDistanceKm"
  | "appearance"
  | "personality"
  | "lifestyle"
  | "dealbreakers"
  | "preferences"
  | "compromises";

export const INTERVIEW_WANTS_TREE: QuestionNode<WantsField>[] = [
  // Bucket 1 — Who they are looking for
  {
    field: "genderPreference",
    bucket: 1,
    text: {
      en: "[redacted:en:genderPreference]",
      he: "[redacted:he:genderPreference]",
      heM: "[redacted:he-m:genderPreference]",
      heF: "[redacted:he-f:genderPreference]",
    },
    kind: "soft",
    // Non-nullable enum. There is no "required" flag for soft nodes, but the
    // engine's finalize() safety net enforces it anyway: a null/invalid value
    // fails WantedProfileSchema and the same node is re-asked until it resolves
    // to one of the four enum values — the soft-node equivalent of a required
    // fact. See interview.engine.ts finalize().
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
  },
  {
    field: "ageMin",
    bucket: 1,
    text: {
      en: "[redacted:en:ageMin]",
      he: "[redacted:he:ageMin]",
      heM: "[redacted:he-m:ageMin]",
      heF: "[redacted:he-f:ageMin]",
    },
    kind: "fact",
    // Wingman is 18+, so the youngest acceptable partner age is 18. extractAge
    // rejects anything under 18 (and the age picker below won't even offer it),
    // so a preference for a minor can never be recorded.
    extract: extractAge,
    probe: {
      en: "[redacted:en]",
      he: "[redacted:he]",
      heM: "[redacted:he-m]",
      heF: "[redacted:he-f]",
    },
    // ageRange.min is non-nullable in WantedProfileSchema, so this must never
    // force-advance to null. Keep probing until we get a valid (18+) number.
    required: true,
    input: { kind: "age", min: MIN_AGE, max: MAX_AGE },
  },
  {
    field: "ageMax",
    bucket: 1,
    text: { en: "[redacted:en:ageMax]", he: "[redacted:he:ageMax]" },
    kind: "fact",
    extract: extractAge,
    probe: {
      en: "[redacted:en:ageMax]",
      he: "[redacted:he:ageMax]",
      heM: "[redacted:he-m:ageMax]",
      heF: "[redacted:he-f:ageMax]",
    },
    // ageRange.max is non-nullable; keep probing. If min > max, finalize() maps
    // the schema refine error (path ["ageRange","max"]) back to this node and
    // re-asks it.
    required: true,
    input: { kind: "age", min: MIN_AGE, max: MAX_AGE },
  },
  {
    field: "maxDistanceKm",
    bucket: 1,
    text: {
      en: "[redacted:en:maxDistanceKm]",
      he: "[redacted:he:maxDistanceKm]",
      heM: "[redacted:he-m:maxDistanceKm]",
      heF: "[redacted:he-f:maxDistanceKm]",
    },
    kind: "fact",
    extract: extractPositiveInt,
    // Non-required: if they type free text with no number (e.g. "same city",
    // "doesn't matter"), the engine force-advances after the probe cap and the
    // wants config's assemble() records the generous default (100 km).
    probe: {
      en: "[redacted:en]",
      he: "[redacted:he]",
      heM: "[redacted:he-m]",
      heF: "[redacted:he-f]",
    },
    // Tappable driving-time options; each value carries the kilometre figure the
    // extractor stores (extractPositiveInt reads the first number). Labels speak
    // in travel time (friendlier), values speak in km (what matching uses).
    input: {
      kind: "choice",
      allowFreeText: true,
      options: [
        {
          label: { en: "[redacted:en]", he: "[redacted:he]" },
          value: { en: "[redacted:en]", he: "[redacted:he]" },
        },
        {
          label: { en: "[redacted:en]", he: "[redacted:he]" },
          value: { en: "[redacted:en]", he: "[redacted:he]" },
        },
        {
          label: { en: "[redacted:en]", he: "[redacted:he]" },
          value: { en: "[redacted:en]", he: "[redacted:he]" },
        },
        {
          label: { en: "[redacted:en]", he: "[redacted:he]" },
          value: { en: "[redacted:en]", he: "[redacted:he]" },
        },
        {
          label: { en: "[redacted:en]", he: "[redacted:he]" },
          value: { en: "[redacted:en]", he: "[redacted:he]" },
        },
      ],
    },
  },

  // Bucket 2 — Appearance (optional; "no preference" is a valid answer)
  {
    field: "appearance",
    bucket: 2,
    text: {
      en: "[redacted:en:appearance]",
      he: "[redacted:he:appearance]",
      heM: "[redacted:he-m:appearance]",
      heF: "[redacted:he-f:appearance]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
  },

  // Bucket 3 — Personality
  {
    field: "personality",
    bucket: 3,
    text: {
      en: "[redacted:en:personality]",
      he: "[redacted:he:personality]",
      heM: "[redacted:he-m:personality]",
      heF: "[redacted:he-f:personality]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
  },

  // Bucket 4 — Lifestyle
  {
    field: "lifestyle",
    bucket: 4,
    text: {
      en: "[redacted:en:lifestyle]",
      he: "[redacted:he:lifestyle]",
      heM: "[redacted:he-m:lifestyle]",
      heF: "[redacted:he-f:lifestyle]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
  },

  // Bucket 5 — Dealbreakers
  {
    field: "dealbreakers",
    bucket: 5,
    text: {
      en: "[redacted:en:dealbreakers]",
      he: "[redacted:he:dealbreakers]",
      heM: "[redacted:he-m:dealbreakers]",
      heF: "[redacted:he-f:dealbreakers]",
    },
    kind: "soft",
    // Every negotiation checks a stated dealbreaker only against what the self
    // interview (questionTree.ts) actually asks the other person — it never
    // asks about smoking, honesty, or income. A dealbreaker on one of those
    // axes can never be confirmed OR cleared; the other agent can only ever
    // say "the profile doesn't specify" (see negotiation.ts's no-data scoring
    // rule). Steer toward dealbreakers this interview or the self interview
    // actually captures (kids, faith, personality, lifestyle, appearance) so
    // what gets recorded is checkable. Record what they say either way — this
    // only shapes which examples/follow-ups the question offers (#319).
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
  },

  // Bucket 6 — Preferences (nice-to-haves)
  {
    field: "preferences",
    bucket: 6,
    text: {
      en: "[redacted:en:preferences]",
      he: "[redacted:he:preferences]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
  },

  // Bucket 7 — Compromises
  {
    field: "compromises",
    bucket: 7,
    text: {
      en: "[redacted:en:compromises]",
      he: "[redacted:he:compromises]",
      heM: "[redacted:he-m:compromises]",
      heF: "[redacted:he-f:compromises]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
  },
];
