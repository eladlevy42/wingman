import { WantedProfileSchema } from "@wingman/shared";
import { prisma } from "@wingman/database";
import { recordEvent } from "../../services/audit.service";

// Deterministic persistence for the Phase-2 (wanted) profile — called directly
// by InterviewEngine.finalize() once the wants tree completes, not by a model
// tool call. See docs/adr/0004 and docs/adr/0005.
// `rawTranscript` is the Phase-2 interview record, assembled by InterviewEngine
// (#488). Optional, and omitting it leaves any stored transcript untouched
// rather than blanking it — see persistProfile for the full rationale.
export async function persistWantedProfile(userId: string, input: unknown, rawTranscript?: string) {
  const data = WantedProfileSchema.parse(input);
  const transcript = rawTranscript === undefined ? {} : { rawTranscript };

  // Both writes must land together — a WantedProfile marked COMPLETED with a
  // User still IDLE would violate the row-existence-based routing in ADR 0002.
  const [wantedProfile] = await prisma.$transaction([
    prisma.wantedProfile.upsert({
      where: { userId },
      update: {
        ...transcript,
        structuredData: JSON.stringify(data),
        status: "COMPLETED",
      },
      create: {
        userId,
        ...transcript,
        structuredData: JSON.stringify(data),
        status: "COMPLETED",
      },
    }),
    // Phase 2 completion is the event that carries the user past the wants
    // interview in login routing. See docs/adr/0002. enteredWaitingAt is set
    // here (not left to createdAt) because a user's account can predate this
    // moment by days — see the User.enteredWaitingAt comment (#343).
    prisma.user.update({
      where: { id: userId },
      data: { matchingState: "WAITING", enteredWaitingAt: new Date() },
    }),
  ]);

  await recordEvent("INTERVIEW_COMPLETED", { mode: "interview_wants" }, { userId });
  await recordEvent(
    "MATCHING_STATE_CHANGED",
    { from: "IDLE", to: "WAITING", trigger: "phase2_completed" },
    { userId }
  );

  return { success: true, wantedProfileId: wantedProfile.id };
}
