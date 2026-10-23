import type { EvalTrack } from "@wingman/shared";

export interface TrackInfo {
  id: EvalTrack;
  name: string;
  description: string;
}

export const TRACKS: TrackInfo[] = [
  {
    id: 1,
    name: "Track 1 — Precision@5",
    description:
      "Deterministic matcher accuracy: each user's actual top-5 candidates vs. their designed golden matches. No LLM calls — free and fast.",
  },
  {
    id: 2,
    name: "Track 2 — Agent Score Correlation",
    description:
      "Runs the real agent-to-agent negotiation on golden pairs and compares both agents' self-scores (plus an independent judge score) against the golden compatibility score.",
  },
  {
    id: 3,
    name: "Track 3 — Grill Extraction Accuracy",
    description:
      "Replays seeded interview transcripts through the interview agent and checks the extracted profile fields against the known-correct structured profile.",
  },
];

export function trackInfo(track: EvalTrack): TrackInfo {
  return TRACKS.find((t) => t.id === track) ?? TRACKS[0];
}
