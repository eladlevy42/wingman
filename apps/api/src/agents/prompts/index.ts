import type { BarneyMode } from "@wingman/shared";
import { INTERVIEW_SELF_PROMPT } from "./interview-self";
import { INTERVIEW_WANTS_PROMPT } from "./interview-wants";
import { PITCH_PROMPT } from "./pitch";
import { DEBRIEF_PROMPT } from "./debrief";

export const PROMPTS_BY_MODE: Record<BarneyMode, string> = {
  interview_self: INTERVIEW_SELF_PROMPT,
  interview_wants: INTERVIEW_WANTS_PROMPT,
  pitch: PITCH_PROMPT,
  debrief: DEBRIEF_PROMPT,
};
