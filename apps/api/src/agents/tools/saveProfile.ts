import { tool } from "@anthropic-ai/claude-agent-sdk";
import { UserProfileSchema, type UserProfile } from "@wingman/shared";
import { prisma } from "@wingman/database";
import { recordEvent } from "../../services/audit.service";

const SAVE_PROFILE_DESCRIPTION =
  "Call this once — at the end of the Phase 1 interview — when you have gathered enough information to build the user's complete self-profile. Do not call it mid-interview. Fill every field you can; leave nullable fields as null only if the user genuinely did not provide the information.";

// Exported directly for the deterministic interview engine (docs/adr/0004),
// which assembles and validates the profile itself and never routes through
// the LLM tool-call path that createSaveProfileTool below serves.
// `rawTranscript` is the record of the interview that produced this profile,
// assembled turn by turn by InterviewEngine (#488). A caller that supplies one
// overwrites the stored transcript rather than appending — the profile is a
// snapshot, and the transcript records the interview that produced the value
// currently stored.
//
// Omitting it is NOT the same as passing "": an absent transcript leaves the
// stored one untouched, so the one caller with no transcript to offer — the LLM
// tool-call path below, where the SDK holds the conversation and never hands it
// over — cannot blank a real record it knows nothing about. The column's own
// "" default still covers the create case.
export async function persistProfile(userId: string, data: UserProfile, rawTranscript?: string) {
  const written = { structuredData: JSON.stringify(data), status: "COMPLETED" };
  const transcript = rawTranscript === undefined ? {} : { rawTranscript };
  const profile = await prisma.profile.upsert({
    where: { userId },
    update: { ...transcript, ...written },
    create: { userId, ...transcript, ...written },
  });
  await recordEvent("INTERVIEW_COMPLETED", { mode: "interview_self" }, { userId });
  return { success: true, profileId: profile.id };
}

// `onSaved` lets BarneyAgent emit its "toolCall" event the moment the SDK
// invokes this handler — see docs/adr/0011 for why tool instantiation moved
// to a per-session factory instead of a static schema+handler pair.
export function createSaveProfileTool(
  userId: string,
  onSaved: (input: UserProfile, result: unknown) => void
) {
  return tool("saveProfile", SAVE_PROFILE_DESCRIPTION, UserProfileSchema.shape, async (input) => {
    const result = await persistProfile(userId, input);
    onSaved(input, result);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
