import type { UserProfile } from "@wingman/shared";
import type { LocalizedChoice, LocalizedInput, Text } from "./localized";

// The deterministic interview flow for Phase 1 (interview_self). See
// docs/adr/0004-deterministic-interview-engine.md. Code — not the model — owns
// this flow: the engine walks these nodes in order, skipping any whose `skipIf`
// matches the profile collected so far. Each node maps to exactly one
// UserProfile field.

export type ProfileField = keyof UserProfile;

// Hobby choices offered by the hobbies multi-select. Labels are redacted in
// the public showcase version. Free-text answers are merged into the same list.
export const HOBBY_OPTIONS: readonly LocalizedChoice[] = [
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
  {
    label: { en: "[redacted:en]", he: "[redacted:he]" },
    value: { en: "[redacted:en]", he: "[redacted:he]" },
  },
];

// Result of a deterministic (no-LLM) extraction for a "fact" node.
export interface FactExtraction {
  sufficient: boolean;
  // The value to store when sufficient. Shape depends on the field; the final
  // schema.parse at persist time is the real guarantee.
  value: unknown;
}

// A node's `field` is generic over a field-name union so each tree keeps its own
// typo-safety: the self tree is QuestionNode<keyof UserProfile>, the wants tree
// is QuestionNode<WantsField>. The engine consumes the erased QuestionNode
// (field: string) since its flow logic is shape-agnostic. Note the wants tree
// uses intermediate field ids (ageMin/ageMax) that are not schema keys — the
// config's assemble() maps collected fields to the final object — so `field` is
// deliberately a free string union, not tied to any one schema.
interface BaseNode<F extends string = string> {
  // The field id this node fills in the collected bag. Also serves as node id.
  field: F;
  // Topic bucket index. Informational / for eval logging.
  bucket: number;
  // The question Barney asks for this field, in every interview language.
  text: Text;
  // Optional branch: skip this node entirely if the predicate holds against the
  // profile collected so far. Only ever reads already-extracted values, so the
  // branch stays deterministic.
  skipIf?: (collected: Record<string, unknown>) => boolean;
  // When skipIf matches, the engine fills the field with this instead of
  // leaving it unset — e.g. deriving country from a well-known city so a
  // required field isn't skipped into a validation failure.
  inferValue?: (collected: Record<string, unknown>) => unknown;
  // How the client should render the input control for this question (18+ age
  // picker, tappable choices, etc.). Defaults to free text when omitted.
  input?: LocalizedInput;
}

// A named topic section, derived from the tree's bucket numbers, used to show a
// title + "Section N of M" in the UI. The engine maps the current node's bucket
// to its position in this ordered list.
export interface InterviewSectionDef {
  bucket: number;
  title: Text;
}

// "fact" — sufficiency + extraction are deterministic (no model). Vagueness is
// not the problem here; a missing number or empty answer is.
export interface FactNode<F extends string = string> extends BaseNode<F> {
  kind: "fact";
  // Deterministic extractor over the raw answer.
  extract: (answer: string) => FactExtraction;
  // The probe shown when the answer is insufficient (the model never phrases
  // fact probes — they are fully deterministic).
  probe: Text;
  // When true, the field is non-nullable in the profile schema, so the engine
  // must NOT force-advance past it on the probe cap — a null would crash the
  // final validation. Required fact nodes keep probing until answered.
  required?: boolean;
}

// "soft" — a single Haiku call judges sufficiency, extracts, and writes the
// acknowledgment/probe. Vagueness is the whole problem for these.
export interface SoftNode<F extends string = string> extends BaseNode<F> {
  kind: "soft";
  // Tells the Haiku call what counts as a sufficient answer.
  sufficiencyGuidance?: string;
  // Tells the Haiku call what shape extracted_value must take.
  extractHint?: string;
}

export type QuestionNode<F extends string = string> = FactNode<F> | SoftNode<F>;

// Wingman is an 18+ product. The extractor pulls the first plausible age number
// out of the answer and rejects anything under 18 (a previous bug accepted 13)
// or implausibly high. Both "no number" and "too young" fall through to the same
// deterministic probe. The age node is `required`, so an under-18 answer keeps
// re-probing and never advances — there is no path into the app for a minor.
export const MIN_AGE = 18;
export const MAX_AGE = 120;

export function extractAge(answer: string): FactExtraction {
  const match = answer.match(/\b(\d{1,3})\b/);
  if (!match) return { sufficient: false, value: null };
  const age = Number(match[1]);
  if (age < MIN_AGE || age > MAX_AGE) return { sufficient: false, value: null };
  return { sufficient: true, value: age };
}

// Matches sentence-prefix patterns users add before a place name:
// "I live in X", "I'm from X", "I grew up in X", "It's in X", etc.
// The Hebrew alternatives are the same patterns a Hebrew answer opens with:
// "אני מ...", "אני גר/ה ב...", "גדלתי ב...", "נולדתי ב...". Hebrew attaches its
// prepositions as a prefix letter (ב/מ) to the place name itself, so only the
// standalone words are stripped — "בתל אביב" keeps its ב, which is harmless
// because both sides of the interview see the same value and the extractor is a
// heuristic, not a geocoder (ADR-0037).
const LOCATION_PREFIX =
  /^(?:i(?:'m| am)\s+(?:from|in|based\s+in|currently\s+in)\s+|i\s+(?:live|grew\s+up|was\s+born)\s+(?:in\s+)?|it(?:'s| is)\s+in\s+|אני\s+(?:גר|גרה|גרים|מ|נמצא|נמצאת)\s*|גדלתי\s+|נולדתי\s+)/i;

// A real city or country is a short name (1-5 words) — "Tel Aviv", "United
// States of America" — never a sentence. Answers longer than this are prose, not
// a place, so they are rejected and re-asked rather than stored verbatim (#228).
// This is a deliberately lightweight deterministic heuristic, not a geocoder:
// it catches rambling off-topic answers (the reported bug) but a short wrong
// answer like "pizza" would still pass — accepting that trade-off keeps these
// basic questions model-free and instant per docs/adr/0004.
const MAX_PLACE_WORDS = 5;

// Short deflections/off-topic replies ("I don't know", "not sure", "why do
// you ask") slip under MAX_PLACE_WORDS, so they're rejected by vocabulary
// instead: negations, question words, and hedging verbs never appear in a real
// city/country name (#228). Deliberately NOT keyed on first/second-person
// pronouns (i/i'm/you/we): a loosely phrased but valid answer can embed the
// place after one ("I'm 30 in Tel Aviv") when LOCATION_PREFIX didn't strip it,
// and every genuine deflection above already trips one of the other words.
// Also covers single-token chat abbreviations of the same deflections ("idk",
// "dunno", "n/a", "nvm") — these pack "I don't know" into one word, so they
// slip past the whole-word checks above and MAX_PLACE_WORDS alike (#409).
// The Hebrew half covers the same deflections: "לא יודע", "לא בטוח", "למה אתה
// שואל", "לא רוצה להגיד", "מה זה משנה", "אין לי מושג" (ADR-0037). JS's \b is
// defined over ASCII word characters, so it cannot delimit Hebrew — these are
// matched as substrings instead, which is safe here because none of them
// appears inside a real Israeli place name.
const NON_PLACE_WORDS_HE =
  /(לא יודע|לא ידוע|לא בטוח|אין לי מושג|למה|מה זה משנה|לא משנה|לא רוצה|לא אגיד|לא רלוונטי|מעדיף לא|מעדיפה לא)/;

const NON_PLACE_WORDS =
  /\b(don'?t|doesn'?t|isn'?t|aren'?t|wasn'?t|weren'?t|can'?t|won'?t|not|no|none|know|sure|guess|idea|ask|asking|why|who|what|whatever|matter|matters|business|care|mind|rather|prefer|want|wants|wanted|tell|telling|say|saying|would|wouldn'?t|question|idk|dunno|n\/a|nvm|meh|whatevs)\b/i;

// Strips preamble and takes the first segment before a comma so that answers
// like "Tel Aviv, Israel" or "I live in New York City, NY" yield clean values.
export function extractLocation(answer: string): FactExtraction {
  const cleaned = answer.trim().replace(LOCATION_PREFIX, "").split(",")[0].trim();
  if (cleaned.length < 2) return { sufficient: false, value: null };
  if (cleaned.split(/\s+/).length > MAX_PLACE_WORDS) return { sufficient: false, value: null };
  if (NON_PLACE_WORDS.test(cleaned)) return { sufficient: false, value: null };
  if (NON_PLACE_WORDS_HE.test(cleaned)) return { sufficient: false, value: null };
  return { sufficient: true, value: cleaned };
}

// Matches filler prefixes users add before a height value.
const HEIGHT_PREFIX =
  /^(?:i(?:'m| am)(?:\s+about)?\s+|(?:about|around|roughly|approximately)\s+|אני\s+(?:בערך\s+)?|(?:בערך|בסביבות|כמעט)\s+)/i;

// A real height value is at most a few tokens ("5'11"", "180 cm",
// "6 feet", or the picker's "175 cm (5'9\")") — never a sentence. A rambling
// answer that happens to contain a digit ("I am 30 years old and love
// hiking") must not slip through just because the bare digit check passes
// (#228).
const MAX_HEIGHT_WORDS = 4;

// Strips preamble and trailing "tall" so "I'm about 5'11" tall" → "5'11"".
// A height always contains a number ("5'11", "180cm", "6 foot"), so an answer
// with no digit is off-topic prose and is re-asked rather than stored (#228).
// Deterministic, no model — see docs/adr/0004. In the live flow the height node
// uses the scrolling height picker, so its answers already carry a number; this
// guard hardens the extractor for any free-text path.
export function extractHeight(answer: string): FactExtraction {
  const cleaned = answer
    .trim()
    .replace(HEIGHT_PREFIX, "")
    .replace(/\s+tall\s*$/i, "")
    .trim();
  if (cleaned.length < 2) return { sufficient: false, value: null };
  if (!/\d/.test(cleaned)) return { sufficient: false, value: null };
  if (cleaned.split(/\s+/).length > MAX_HEIGHT_WORDS) return { sufficient: false, value: null };
  return { sufficient: true, value: cleaned };
}

// Pulls the first positive integer out of an answer — used by the wants tree for
// age bounds and max distance. Any "same city"/"an hour away" phrasing with no
// number is insufficient; the wants tree handles that via its probe/default.
export function extractPositiveInt(answer: string): FactExtraction {
  const match = answer.match(/\d+/);
  if (!match) return { sufficient: false, value: null };
  const value = Number(match[0]);
  if (!Number.isFinite(value) || value <= 0) return { sufficient: false, value: null };
  return { sufficient: true, value };
}

export const INTERVIEW_SELF_TREE: QuestionNode<keyof UserProfile & string>[] = [
  // Bucket 1 — Basics
  {
    field: "age",
    bucket: 1,
    text: {
      en: "[redacted:en:age]",
      he: "[redacted:he:age]",
      heM: "[redacted:he-m:age]",
      heF: "[redacted:he-f:age]",
    },
    kind: "fact",
    extract: extractAge,
    probe: {
      en: "[redacted:en]",
      he: "[redacted:he]",
      heM: "[redacted:he-m]",
      heF: "[redacted:he-f]",
    },
    required: true,
    input: { kind: "age", min: MIN_AGE, max: MAX_AGE },
  },
  {
    field: "city",
    bucket: 1,
    text: {
      en: "[redacted:en:city]",
      he: "[redacted:he:city]",
      heM: "[redacted:he-m:city]",
      heF: "[redacted:he-f:city]",
    },
    kind: "fact",
    extract: extractLocation,
    probe: {
      en: "[redacted:en]",
      he: "[redacted:he]",
      heM: "[redacted:he-m]",
      heF: "[redacted:he-f]",
    },
    required: true,
  },
  // The country question was removed entirely (#530). Wingman is Israel-only by
  // construction — registration is gated to Tel Aviv University addresses
  // (ALLOWED_UNIVERSITY_DOMAINS) and every seeded user is Israeli — so asking
  // spent an interview turn to learn something already known, and an
  // unrecognized city could put a nonsense country on a real profile. The field
  // is now filled unconditionally in interview.config.ts's assembleSelf.
  // If Wingman ever opens beyond Israel, this node comes back rather than the
  // constant being widened.
  {
    field: "job",
    bucket: 1,
    text: {
      en: "[redacted:en:job]",
      he: "[redacted:he:job]",
      heM: "[redacted:he-m:job]",
      heF: "[redacted:he-f:job]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
  },
  {
    field: "education",
    bucket: 1,
    text: {
      en: "[redacted:en:education]",
      he: "[redacted:he:education]",
      heM: "[redacted:he-m:education]",
      heF: "[redacted:he-f:education]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
  },

  // Bucket 2 — Personality & Character
  {
    field: "conflict_style",
    bucket: 2,
    text: {
      en: "[redacted:en:conflict_style]",
      he: "[redacted:he:conflict_style]",
      heM: "[redacted:he-m:conflict_style]",
      heF: "[redacted:he-f:conflict_style]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
  },
  {
    field: "emotional_openness",
    bucket: 2,
    text: {
      en: "[redacted:en:emotional_openness]",
      he: "[redacted:he:emotional_openness]",
      heM: "[redacted:he-m:emotional_openness]",
      heF: "[redacted:he-f:emotional_openness]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
  },
  {
    field: "treatment_of_others",
    bucket: 2,
    text: {
      en: "[redacted:en:treatment_of_others]",
      he: "[redacted:he:treatment_of_others]",
      heM: "[redacted:he-m:treatment_of_others]",
      heF: "[redacted:he-f:treatment_of_others]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
  },
  {
    field: "personality_traits",
    bucket: 2,
    text: {
      en: "[redacted:en:personality_traits]",
      he: "[redacted:he:personality_traits]",
      heM: "[redacted:he-m:personality_traits]",
      heF: "[redacted:he-f:personality_traits]",
    },
    kind: "soft",
    // Mirrors the wants tree's `personality` node — see docs/adr/0021.
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
  },

  // Bucket 3 — Values & Life Priorities
  {
    field: "wants_kids",
    bucket: 3,
    text: {
      en: "[redacted:en:wants_kids]",
      he: "[redacted:he:wants_kids]",
      heM: "[redacted:he-m:wants_kids]",
      heF: "[redacted:he-f:wants_kids]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
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
      ],
    },
  },
  {
    field: "kids_timeline",
    bucket: 3,
    text: {
      en: "[redacted:en:kids_timeline]",
      he: "[redacted:he:kids_timeline]",
      heM: "[redacted:he-m:kids_timeline]",
      heF: "[redacted:he-f:kids_timeline]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
    // Cheap, deterministic branch: only ask about timeline if they actually want
    // kids. Reads the already-extracted wants_kids value.
    skipIf: (collected) => collected.wants_kids !== true,
  },
  {
    field: "faith",
    bucket: 3,
    text: {
      en: "[redacted:en:faith]",
      he: "[redacted:he:faith]",
      heM: "[redacted:he-m:faith]",
      heF: "[redacted:he-f:faith]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
    // Converted to a chip picklist (#417 lever 3, mirrors wants_kids/social_energy)
    // — most answers land on one of these four buckets, and allowFreeText keeps
    // the door open for real nuance.
    input: {
      kind: "choice",
      allowFreeText: true,
      options: [
        {
          label: { en: "[redacted:en]", he: "[redacted:he]" },
          value: {
            en: "[redacted:en]",
            he: "[redacted:he]",
          },
        },
        {
          label: { en: "[redacted:en]", he: "[redacted:he]" },
          value: {
            en: "[redacted:en]",
            he: "[redacted:he]",
          },
        },
        {
          label: { en: "[redacted:en]", he: "[redacted:he]" },
          value: {
            en: "[redacted:en]",
            he: "[redacted:he]",
          },
        },
        {
          // The label and value are the user's own words, so they conjugate by
          // the user's gender, not Barney's.
          label: { en: "[redacted:en]", he: "[redacted:he]", heF: "[redacted:he-f]" },
          value: {
            en: "[redacted:en]",
            he: "[redacted:he]",
            heF: "[redacted:he-f]",
          },
        },
      ],
    },
  },
  {
    field: "current_motivation",
    bucket: 3,
    text: {
      en: "[redacted:en:current_motivation]",
      he: "[redacted:he:current_motivation]",
      heM: "[redacted:he-m:current_motivation]",
      heF: "[redacted:he-f:current_motivation]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
  },
  {
    field: "life_vision",
    bucket: 3,
    text: {
      en: "[redacted:en:life_vision]",
      he: "[redacted:he:life_vision]",
      heM: "[redacted:he-m:life_vision]",
      heF: "[redacted:he-f:life_vision]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
  },

  // Bucket 4 — Hobbies & Interests
  {
    field: "hobbies",
    bucket: 4,
    text: {
      en: "[redacted:en:hobbies]",
      he: "[redacted:he:hobbies]",
      heM: "[redacted:he-m:hobbies]",
      heF: "[redacted:he-f:hobbies]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    // Names only. This used to also demand `centrality` and `solo_or_social`,
    // which made the extracted shape strict enough that a partial extraction
    // failed validation and the answer was silently dropped (#529). Nothing
    // downstream reads those two fields; matching reads names alone.
    extractHint: "Redacted.",
    input: {
      kind: "multiChoice",
      allowFreeText: true,
      confirmLabel: { en: "[redacted:en]", he: "[redacted:he]" },
      options: HOBBY_OPTIONS,
    },
  },

  // Bucket 5 — Lifestyle & Daily Reality
  // The "week-to-week social life" node (social_circle) was cut here (#417) —
  // it overlapped with the introvert/extrovert signal this question already
  // captures, and the field is never read by matching/negotiation (checked).
  {
    field: "social_energy",
    bucket: 5,
    text: {
      en: "[redacted:en:social_energy]",
      he: "[redacted:he:social_energy]",
      heM: "[redacted:he-m:social_energy]",
      heF: "[redacted:he-f:social_energy]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
    input: {
      kind: "choice",
      allowFreeText: true,
      options: [
        {
          // First-person answers, conjugated by the user's gender.
          label: { en: "[redacted:en]", he: "[redacted:he]", heF: "[redacted:he-f]" },
          value: {
            en: "[redacted:en]",
            he: "[redacted:he]",
            heF: "[redacted:he-f]",
          },
        },
        {
          label: { en: "[redacted:en]", he: "[redacted:he]", heF: "[redacted:he-f]" },
          value: {
            en: "[redacted:en]",
            he: "[redacted:he]",
            heF: "[redacted:he-f]",
          },
        },
        {
          label: { en: "[redacted:en]", he: "[redacted:he]" },
          value: { en: "[redacted:en]", he: "[redacted:he]" },
        },
      ],
    },
  },

  // Bucket 6 — Appearance (asked last so physical questions land naturally at
  // the end, after personality and lifestyle, rather than up front among the
  // basics.)
  {
    field: "appearance",
    bucket: 6,
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
  {
    // Reinstated in #530 as a tappable picklist. This question was cut in #417
    // for overlapping with the free-form appearance question above; the product
    // decision is that build is worth asking explicitly, and asking it as a
    // choice — like age and height — keeps the value tidy and instant to answer
    // rather than depending on whether a free-text answer happened to mention
    // it. Do not re-cut it. Note the field is still read by nothing in matching
    // or negotiation: it is for profile completeness and display.
    field: "body_type",
    bucket: 6,
    text: {
      en: "[redacted:en:body_type]",
      he: "[redacted:he:body_type]",
      heM: "[redacted:he-m:body_type]",
      heF: "[redacted:he-f:body_type]",
    },
    kind: "soft",
    sufficiencyGuidance: "Redacted.",
    extractHint: "Redacted.",
    input: {
      kind: "choice",
      allowFreeText: true,
      options: [
        // Build adjectives describe the user, so they conjugate by the user's
        // gender.
        {
          label: { en: "[redacted:en]", he: "[redacted:he]" },
          value: { en: "[redacted:en]", he: "[redacted:he]" },
        },
        {
          label: { en: "[redacted:en]", he: "[redacted:he]", heF: "[redacted:he-f]" },
          value: { en: "[redacted:en]", he: "[redacted:he]", heF: "[redacted:he-f]" },
        },
        {
          label: { en: "[redacted:en]", he: "[redacted:he]", heF: "[redacted:he-f]" },
          value: { en: "[redacted:en]", he: "[redacted:he]", heF: "[redacted:he-f]" },
        },
        {
          label: { en: "[redacted:en]", he: "[redacted:he]", heF: "[redacted:he-f]" },
          value: { en: "[redacted:en]", he: "[redacted:he]", heF: "[redacted:he-f]" },
        },
        {
          label: { en: "[redacted:en]", he: "[redacted:he]", heF: "[redacted:he-f]" },
          value: { en: "[redacted:en]", he: "[redacted:he]", heF: "[redacted:he-f]" },
        },
        {
          label: { en: "[redacted:en]", he: "[redacted:he]", heF: "[redacted:he-f]" },
          value: { en: "[redacted:en]", he: "[redacted:he]", heF: "[redacted:he-f]" },
        },
        {
          label: { en: "[redacted:en]", he: "[redacted:he]", heF: "[redacted:he-f]" },
          value: {
            en: "[redacted:en]",
            he: "[redacted:he]",
            heF: "[redacted:he-f]",
          },
        },
      ],
    },
  },
  {
    // Height is collected via a scrolling picker (input.kind "height") rather
    // than free text, so the value is always a well-formed height and can never
    // be off-topic prose (#228). extractHeight still guards any free-text path.
    // Not `required` — the profile schema allows a null height, so an unanswered
    // height must not block completion.
    field: "height",
    bucket: 6,
    text: {
      en: "[redacted:en:height]",
      he: "[redacted:he:height]",
      heM: "[redacted:he-m:height]",
      heF: "[redacted:he-f:height]",
    },
    kind: "fact",
    extract: extractHeight,
    probe: {
      en: "[redacted:en]",
      he: "[redacted:he]",
      heM: "[redacted:he-m]",
      heF: "[redacted:he-f]",
    },
    input: { kind: "height", minCm: 140, maxCm: 210 },
  },
];

// Section titles for Phase 1, in the order the buckets are asked. The engine
// maps the current node's bucket to its 1-based position here for the UI header.
export const SELF_SECTIONS: InterviewSectionDef[] = [
  { bucket: 1, title: { en: "[redacted:en]", he: "[redacted:he]" } },
  {
    bucket: 2,
    title: {
      en: "[redacted:en]",
      he: "[redacted:he]",
      heM: "[redacted:he-m]",
      heF: "[redacted:he-f]",
    },
  },
  {
    bucket: 3,
    title: {
      en: "[redacted:en]",
      he: "[redacted:he]",
      heM: "[redacted:he-m]",
      heF: "[redacted:he-f]",
    },
  },
  {
    bucket: 4,
    title: {
      en: "[redacted:en]",
      he: "[redacted:he]",
      heM: "[redacted:he-m]",
      heF: "[redacted:he-f]",
    },
  },
  {
    bucket: 5,
    title: {
      en: "[redacted:en]",
      he: "[redacted:he]",
      heM: "[redacted:he-m]",
      heF: "[redacted:he-f]",
    },
  },
  { bucket: 6, title: { en: "[redacted:en]", he: "[redacted:he]" } },
];
