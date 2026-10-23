import bcrypt from "bcryptjs";
import { prisma } from "@wingman/database";
import {
  RegisterInputSchema,
  LoginInputSchema,
  StudentAuthInputSchema,
  UserResponseSchema,
  UserStateResponseSchema,
  PhotoUploadInputSchema,
  MatchPhotoResponseSchema,
  UserProfileSchema,
} from "@wingman/shared";
import type { UserStateResponse, MatchPhotoResponse } from "@wingman/shared";
import type { z } from "zod";
import { timeSelectionView } from "./scheduling.service";
import { recordEvent } from "./audit.service";

// bcrypt work factor. 10 is the library default — a sensible balance of security
// and speed for a POC; the value is embedded in each hash so it can be raised
// later without invalidating existing hashes.
const BCRYPT_ROUNDS = 10;

type UserResponse = z.infer<typeof UserResponseSchema>;

function toUserResponse(user: {
  id: string;
  email: string;
  name: string;
  gender: string;
  createdAt: Date;
}): UserResponse {
  return UserResponseSchema.parse({
    ...user,
    createdAt: user.createdAt.toISOString(),
  });
}

export async function registerUser(input: unknown): Promise<UserResponse> {
  // The password is stored only as a bcrypt hash — never persist the plaintext,
  // so pull it out of the data that reaches prisma.user.create (#277).
  const { password, ...data } = RegisterInputSchema.parse(input);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await prisma.user.create({ data: { ...data, passwordHash } });
  await recordEvent("USER_REGISTERED", {}, { userId: user.id });
  return toUserResponse(user);
}

export async function loginUser(input: unknown): Promise<UserResponse> {
  const { email, password } = LoginInputSchema.parse(input);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new NotFoundError("User not found");
  // Verify the password against the stored bcrypt hash. The null check is for
  // rows left behind by the removed social sign-in (#512): no new account can
  // be created without a password, but an existing passwordless row would
  // otherwise make bcrypt.compare throw rather than fail the login cleanly.
  if (!user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new InvalidCredentialsError("Incorrect email or password");
  }
  await recordEvent("USER_AUTHENTICATED", { method: "password" }, { userId: user.id });
  return toUserResponse(user);
}

// The "Verify Your University" step (#275), run right after sign-up. Validates
// the university email (must be a recognised university address — the Zod schema
// enforces the allowlist), stores the student id, and saves only a bcrypt hash
// of the password (never the plaintext). Returns the public user shape, which
// deliberately excludes universityEmail/studentId/passwordHash.
export async function authenticateStudent(userId: string, input: unknown): Promise<UserResponse> {
  const { universityEmail, studentId, password } = StudentAuthInputSchema.parse(input);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError("User not found");

  // The university password is a separate credential from the account login
  // password (#277) — stored in its own hashed column.
  const universityPasswordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { universityEmail, studentId, universityPasswordHash },
  });
  await recordEvent("USER_AUTHENTICATED", { method: "university" }, { userId });
  return toUserResponse(updated);
}

export async function getUserById(id: string): Promise<UserResponse> {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFoundError("User not found");
  return toUserResponse(user);
}

// Drives the login redirect. hasProfile means Phase 1 onboarding is complete
// (a Profile row exists with status COMPLETED); matchingState drives the
// post-onboarding screens. See docs/adr/0002.
export async function getUserState(id: string): Promise<UserStateResponse> {
  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      profile: true,
      matchesAsA: { where: { status: "MATCHED" }, orderBy: { createdAt: "desc" } },
      matchesAsB: { where: { status: "MATCHED" }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!user) throw new NotFoundError("User not found");

  // A user can accumulate more than one MATCHED Match row across successive
  // matching cycles (#77 re-enters a debriefed user into matching without
  // retiring their prior Match) — pick the most recently created one across
  // both sides, mirroring the orderBy+pick-latest convention blindDate.service.ts
  // already uses for the same "which Match is current" question.
  const matchedMatch = [...user.matchesAsA, ...user.matchesAsB].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  )[0];
  const matchedWith = matchedMatch
    ? matchedMatch.userAId === id
      ? matchedMatch.userBId
      : matchedMatch.userAId
    : undefined;

  const followUp = matchedMatch
    ? await prisma.followUp.findUnique({
        where: { userId_matchId: { userId: id, matchId: matchedMatch.id } },
      })
    : null;

  // Surface the choose-your-times slate only while the user is actually picking
  // (#248) — outside CHOOSING_TIMES these stay undefined so /state, which is
  // polled frequently, carries no stale slot data.
  const timeSelection =
    user.matchingState === "CHOOSING_TIMES" && matchedMatch
      ? timeSelectionView(matchedMatch, id)
      : undefined;

  return UserStateResponseSchema.parse({
    matchingState: user.matchingState,
    hasProfile: user.profile?.status === "COMPLETED",
    universityVerified: user.universityEmail !== null,
    // Presence only — never the photo itself. /state is polled frequently and
    // photoUrl is a multi-MB base64 data URL, which is why getMatchPhoto keeps
    // the bytes on their own endpoint.
    hasPhoto: user.photoUrl !== null,
    matchedWith,
    matchId: matchedMatch?.id,
    followUpState: followUp?.state,
    timeRole: timeSelection?.timeRole,
    candidateSlots: timeSelection?.candidateSlots,
    proposedSlots: timeSelection?.proposedSlots,
    hasSubmittedAvailability: timeSelection?.hasSubmittedAvailability,
  });
}

// The current MATCHED partner's photo, shown on the Pitch page right before the
// Yeah/Nah decision (the reveal Barney teases during the 3 questions). Fetched
// on its own endpoint rather than folded into getUserState because the photo is
// a multi-MB base64 data URL and /state is polled frequently. Returns a null
// photoUrl (not an error) when there is no current match or the partner has no
// photo, so the Pitch page can degrade gracefully rather than break the decision.
export async function getMatchPhoto(userId: string): Promise<MatchPhotoResponse> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      matchesAsA: { where: { status: "MATCHED" }, orderBy: { createdAt: "desc" } },
      matchesAsB: { where: { status: "MATCHED" }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!user) throw new NotFoundError("User not found");

  // Same "which Match is current" pick as getUserState — most recent MATCHED
  // row across both sides.
  const matchedMatch = [...user.matchesAsA, ...user.matchesAsB].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
  )[0];
  if (!matchedMatch) return MatchPhotoResponseSchema.parse({ photoUrl: null });

  const partnerId = matchedMatch.userAId === userId ? matchedMatch.userBId : matchedMatch.userAId;
  const partner = await prisma.user.findUnique({
    where: { id: partnerId },
    include: { profile: true },
  });

  // ADR-0022: the pitch reveals the match's name + education on the
  // "Introducing…" card. Education comes from the partner's structured profile;
  // a missing/malformed profile degrades to null (this endpoint never throws for
  // a data gap — the pitch still runs on the name + photo).
  let education: string | null = null;
  if (partner?.profile?.structuredData) {
    try {
      const parsed = UserProfileSchema.safeParse(JSON.parse(partner.profile.structuredData));
      if (parsed.success) education = parsed.data.education ?? null;
    } catch {
      // Malformed JSON in structuredData — treat as no education on record.
    }
  }

  return MatchPhotoResponseSchema.parse({
    photoUrl: partner?.photoUrl ?? null,
    partnerName: partner?.name ?? null,
    education,
  });
}

// Persists the Match Photo requested by Barney right after Phase 2 completes
// (#200, docs/adr/0016). Deliberately not returned by toUserResponse/
// UserResponseSchema — see that schema's note on GET /api/users/:id having no
// ownership check.
export async function savePhoto(userId: string, input: unknown): Promise<void> {
  const { photoUrl } = PhotoUploadInputSchema.parse(input);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError("User not found");
  await prisma.user.update({ where: { id: userId }, data: { photoUrl } });
  // Presence only — the payload schema has no field that could carry the photo.
  await recordEvent("PHOTO_UPLOADED", {}, { userId });
}

export class NotFoundError extends Error {}

// Wrong password for an existing account. Kept distinct from NotFoundError so
// the route can answer with 401 rather than 404 (#277).
export class InvalidCredentialsError extends Error {}
