import { z } from "zod";

// One user's post-match follow-up relative to their auto-assigned Blind Date
// (issue #67, docs/adr/0012): AWAITING_DATE until the date passes, then
// DATE_PASSED until the debrief (#75) completes it to DEBRIEFED.
export const FollowUpStateSchema = z.enum(["AWAITING_DATE", "DATE_PASSED", "DEBRIEFED"]);

export type FollowUpState = z.infer<typeof FollowUpStateSchema>;
