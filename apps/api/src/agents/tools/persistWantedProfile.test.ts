import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@wingman/database", () => ({
  prisma: {
    wantedProfile: {
      upsert: vi.fn(),
    },
    user: {
      update: vi.fn(),
    },
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));

vi.mock("../../services/audit.service", () => ({ recordEvent: vi.fn() }));

import { prisma } from "@wingman/database";
import { persistWantedProfile } from "./persistWantedProfile";
import { recordEvent } from "../../services/audit.service";

const USER_ID = "123e4567-e89b-12d3-a456-426614174000";
const WANTED_PROFILE_ID = "bbb00000-e89b-12d3-a456-426614174000";

const validInput = {
  genderPreference: "female" as const,
  ageRange: { min: 25, max: 35 },
  maxDistanceKm: 50,
  appearance: ["tall", "athletic"],
  personality: ["funny", "ambitious"],
  lifestyle: ["non-smoker", "active"],
  dealbreakers: ["smoking"],
  preferences: ["shares a hobby"],
  compromises: ["willing to date a smoker if strongly compatible"],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.wantedProfile.upsert).mockResolvedValue({
    id: WANTED_PROFILE_ID,
    userId: USER_ID,
    rawTranscript: "",
    structuredData: JSON.stringify(validInput),
    status: "COMPLETED",
  });
});

describe("persistWantedProfile", () => {
  it("upserts the wanted profile with structuredData and status COMPLETED", async () => {
    const result = await persistWantedProfile(USER_ID, validInput);

    expect(prisma.wantedProfile.upsert).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      update: {
        structuredData: expect.any(String),
        status: "COMPLETED",
      },
      create: {
        userId: USER_ID,
        structuredData: expect.any(String),
        status: "COMPLETED",
      },
    });
    expect(result).toEqual({ success: true, wantedProfileId: WANTED_PROFILE_ID });
  });

  it("persists the supplied transcript on both create and update (#488)", async () => {
    const transcript = "Barney: Who are you looking for?\nUser: Someone funny.";

    await persistWantedProfile(USER_ID, validInput, transcript);

    const call = vi.mocked(prisma.wantedProfile.upsert).mock.calls[0][0];
    expect(call.create.rawTranscript).toBe(transcript);
    expect(call.update.rawTranscript).toBe(transcript);
  });

  it("leaves a stored transcript untouched when no transcript is supplied (#488)", async () => {
    await persistWantedProfile(USER_ID, validInput);

    const call = vi.mocked(prisma.wantedProfile.upsert).mock.calls[0][0];
    expect(call.update).not.toHaveProperty("rawTranscript");
    expect(call.create).not.toHaveProperty("rawTranscript");
  });

  it("serializes the parsed profile as JSON in structuredData", async () => {
    await persistWantedProfile(USER_ID, validInput);

    const call = vi.mocked(prisma.wantedProfile.upsert).mock.calls[0][0];
    const stored = JSON.parse(call.create.structuredData as string);
    expect(stored.genderPreference).toBe("female");
    expect(stored.ageRange).toEqual({ min: 25, max: 35 });
    expect(stored.dealbreakers).toEqual(["smoking"]);
  });

  it("flips the user's matchingState to WAITING on successful persist", async () => {
    await persistWantedProfile(USER_ID, validInput);

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { matchingState: "WAITING", enteredWaitingAt: expect.any(Date) },
    });
  });

  // #552: Phase 2 completion is both an interview milestone and the
  // IDLE -> WAITING transition, so it records two audit events.
  it("records INTERVIEW_COMPLETED and the IDLE -> WAITING transition", async () => {
    await persistWantedProfile(USER_ID, validInput);

    expect(recordEvent).toHaveBeenCalledWith(
      "INTERVIEW_COMPLETED",
      { mode: "interview_wants" },
      { userId: USER_ID }
    );
    expect(recordEvent).toHaveBeenCalledWith(
      "MATCHING_STATE_CHANGED",
      { from: "IDLE", to: "WAITING", trigger: "phase2_completed" },
      { userId: USER_ID }
    );
  });

  it("records no audit event when validation rejects the input", async () => {
    await expect(
      persistWantedProfile(USER_ID, { ...validInput, genderPreference: "unknown" })
    ).rejects.toThrow();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("accepts empty arrays for lists the user had nothing to add to", async () => {
    await persistWantedProfile(USER_ID, { ...validInput, appearance: [] });

    const call = vi.mocked(prisma.wantedProfile.upsert).mock.calls[0][0];
    const stored = JSON.parse(call.create.structuredData as string);
    expect(stored.appearance).toEqual([]);
  });

  it("throws ZodError and does not touch prisma when input is invalid", async () => {
    await expect(
      persistWantedProfile(USER_ID, { ...validInput, genderPreference: "unknown" })
    ).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("throws ZodError when a required field is missing", async () => {
    const input = Object.fromEntries(
      Object.entries(validInput).filter(([k]) => k !== "maxDistanceKm")
    );
    await expect(persistWantedProfile(USER_ID, input)).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
