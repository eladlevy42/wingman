// Constants and scripted answers for the full-run E2E (#564).
//
// The two users are a synthetic pair who satisfy each other's hard filters
// (gender, age range, distance). Interview answers are placeholders.

export const API_URL = "http://localhost:3001";
export const WEB_URL = "http://localhost:8081";

export const EVIDENCE_DIR = "../../../docs/screenshots";

// How a single interview turn is answered. Keyed by the engine's `answered`
// count (the header's "N / T" minus one), which is deterministic for a fixed
// tree and fixed answers; only the soft-question wording comes from Haiku.
export type ScriptedAnswer =
  | { kind: "text"; text: string }
  | { kind: "choice"; label: string }
  | { kind: "multi"; labels: string[]; confirm: string }
  | { kind: "picker"; label: string };

export interface FullRunUser {
  key: "a" | "b";
  name: string;
  gender: "male" | "female";
  phase1: ScriptedAnswer[];
  phase2: ScriptedAnswer[];
}

// Mirrors apps/mobile/lib/formatHeight.ts, which is what the height picker
// shows as its option labels.
function heightLabel(cm: number): string {
  const totalInches = Math.round(cm / 2.54);
  return `${cm} cm (${Math.floor(totalInches / 12)}'${totalInches % 12}")`;
}

const text = (value: string): ScriptedAnswer => ({ kind: "text", text: value });
const choice = (label: string): ScriptedAnswer => ({ kind: "choice", label });
const picker = (label: string): ScriptedAnswer => ({ kind: "picker", label });

export const WRAPUP_ANSWER = "Synthetic wrap-up.";

const answer = text("Synthetic answer.");

export const USER_A: FullRunUser = {
  key: "a",
  name: "Alex",
  gender: "female",
  phase1: [
    picker("27"),
    text("Tel Aviv"),
    answer,
    answer,
    answer,
    answer,
    answer,
    answer,
    choice("Synthetic"),
    answer,
    answer,
    answer,
    answer,
    { kind: "multi", labels: ["Synthetic"], confirm: "Done" },
    choice("Synthetic"),
    answer,
    choice("Synthetic"),
    picker(heightLabel(168)),
  ],
  phase2: [
    answer,
    picker("26"),
    picker("36"),
    choice("Synthetic"),
    answer,
    answer,
    answer,
    answer,
    answer,
    answer,
  ],
};

export const USER_B: FullRunUser = {
  key: "b",
  name: "Sam",
  gender: "male",
  phase1: [
    picker("30"),
    text("Tel Aviv"),
    answer,
    answer,
    answer,
    answer,
    answer,
    answer,
    choice("Synthetic"),
    answer,
    answer,
    answer,
    answer,
    { kind: "multi", labels: ["Synthetic"], confirm: "Done" },
    choice("Synthetic"),
    answer,
    choice("Synthetic"),
    picker(heightLabel(186)),
  ],
  phase2: [
    answer,
    picker("24"),
    picker("32"),
    choice("Synthetic"),
    answer,
    answer,
    answer,
    answer,
    answer,
    answer,
  ],
};

export const PITCH_QUESTIONS = [
  "Synthetic question 1",
  "Synthetic question 2",
  "Synthetic question 3",
];
