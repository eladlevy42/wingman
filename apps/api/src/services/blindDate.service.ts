import { prisma } from "@wingman/database";
import { UserProfileSchema, BlindDateResponseSchema } from "@wingman/shared";
import type { BlindDateResponse } from "@wingman/shared";
import { NotFoundError } from "./user.service";

export class BlindDateNotFoundError extends Error {}

// Backs GET /api/users/:id/blind-date (#57): the DATE_ASSIGNED reveal page
// needs the assigned venue/dateTime plus the matched partner's full,
// revealed UserProfile — see docs/adr/0012.
export async function getBlindDate(userId: string): Promise<BlindDateResponse> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError("User not found");

  const match = await prisma.match.findFirst({
    where: {
      OR: [{ userAId: userId }, { userBId: userId }],
      status: "MATCHED",
      venue: { not: null },
      dateTime: { not: null },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!match || !match.venue || !match.dateTime) {
    throw new BlindDateNotFoundError(`No assigned Blind Date found for user ${userId}`);
  }

  const partnerId = match.userAId === userId ? match.userBId : match.userAId;
  const partner = await prisma.user.findUnique({
    where: { id: partnerId },
    include: { profile: true },
  });
  if (!partner?.profile?.structuredData) {
    // Distinct from "no date assigned yet" above: a resolved match's partner
    // missing a profile is a data-integrity violation (decision.service.ts
    // only resolves matches between users who already completed onboarding),
    // not a normal not-found — log it so it doesn't silently masquerade as
    // the ordinary case on the client.
    console.error(`blindDate: resolved match ${match.id} has partner ${partnerId} with no profile`);
    throw new BlindDateNotFoundError(`Partner profile not found for match ${match.id}`);
  }

  if (!partner.photoUrl) {
    // The photo upload gate (docs/adr/0016) is required before a user can
    // enter matching, so a resolved match's partner missing one is a
    // data-integrity violation, not a normal not-found.
    console.error(
      `blindDate: resolved match ${match.id} has partner ${partnerId} with no photoUrl`
    );
    throw new BlindDateNotFoundError(`Partner photo not found for match ${match.id}`);
  }

  const partnerProfile = UserProfileSchema.parse(JSON.parse(partner.profile.structuredData));

  return BlindDateResponseSchema.parse({
    venue: match.venue,
    dateTime: match.dateTime.toISOString(),
    partnerName: partner.name,
    partnerPhotoUrl: partner.photoUrl,
    // The requesting user's own photo, for the paired heart on the date card.
    // Falls back to "" rather than throwing: unlike the partner's photo, a
    // missing self photo should degrade the card, not break the page.
    selfPhotoUrl: user.photoUrl ?? "",
    partnerProfile,
  });
}
