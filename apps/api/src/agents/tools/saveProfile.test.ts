import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@wingman/database", () => ({
  prisma: {
    profile: {
      upsert: vi.fn(),
    },
  },
}));

vi.mock("../../services/audit.service", () => ({ recordEvent: vi.fn() }));

import { prisma } from "@wingman/database";
import { createSaveProfileTool, persistProfile } from "./saveProfile";
import { recordEvent } from "../../services/audit.service";

const USER_ID = "123e4567-e89b-12d3-a456-426614174000";
const PROFILE_ID = "aaa00000-e89b-12d3-a456-426614174000";

const validInput = {
  age: 28,
  city: "Tel Aviv",
  country: "Israel",
  height: "175cm",
  job: "Product Designer",
  hometown: "Haifa",
  education: "Computer Science",
  body_type: "athletic",
  appearance: "Casual and put-together",
  conflict_style: "Says things directly",
  emotional_openness: "Open with close friends",
  treatment_of_others: "Goes out of the way to help",
  personality_traits: ["funny", "ambitious"],
  wants_kids: true,
  kids_timeline: "Sometime in the next 5 years",
  faith: "Cultural Jewish, not religious",
  current_motivation: "Career and travel",
  life_vision: "Live abroad then settle somewhere warm",
  hobbies: [
    { name: "hiking", centrality: "every weekend", solo_or_social: "social" },
    { name: "cooking", centrality: "casual", solo_or_social: "solo" },
  ],
  typical_weekend: "Farmer's market, hike, low-key dinner",
  social_energy: "extrovert" as const,
  social_circle: "Large but close",
  photoUrls: [],
  additionalNotes: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createSaveProfileTool", () => {
  it("is named saveProfile and lists all required fields in its schema shape", () => {
    const profileTool = createSaveProfileTool(USER_ID, vi.fn());
    const required = Object.keys(profileTool.inputSchema);
    expect(profileTool.name).toBe("saveProfile");
    expect(required).toContain("age");
    expect(required).toContain("city");
    expect(required).toContain("country");
    expect(required).toContain("wants_kids");
    expect(required).toContain("hobbies");
    expect(required).toContain("social_energy");
  });

  it("upserts the profile with structuredData and status COMPLETED, then calls onSaved", async () => {
    vi.mocked(prisma.profile.upsert).mockResolvedValue({
      id: PROFILE_ID,
      userId: USER_ID,
      rawTranscript: "",
      structuredData: JSON.stringify(validInput),
      status: "COMPLETED",
    });
    const onSaved = vi.fn();
    const profileTool = createSaveProfileTool(USER_ID, onSaved);

    const result = await profileTool.handler(validInput, undefined);

    expect(prisma.profile.upsert).toHaveBeenCalledWith({
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
    expect(onSaved).toHaveBeenCalledWith(validInput, { success: true, profileId: PROFILE_ID });
    expect(result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ success: true, profileId: PROFILE_ID }) }],
    });
  });

  it("persists the supplied transcript on both create and update (#488)", async () => {
    vi.mocked(prisma.profile.upsert).mockResolvedValue({
      id: PROFILE_ID,
      userId: USER_ID,
      rawTranscript: "",
      structuredData: "{}",
      status: "COMPLETED",
    });
    const transcript = "Barney: How old are you?\nUser: 28.";

    await persistProfile(USER_ID, validInput, transcript);

    const call = vi.mocked(prisma.profile.upsert).mock.calls[0][0];
    expect(call.create.rawTranscript).toBe(transcript);
    expect(call.update.rawTranscript).toBe(transcript);
  });

  it("leaves a stored transcript untouched when the caller has none (#488)", async () => {
    vi.mocked(prisma.profile.upsert).mockResolvedValue({
      id: PROFILE_ID,
      userId: USER_ID,
      rawTranscript: "",
      structuredData: "{}",
      status: "COMPLETED",
    });
    const profileTool = createSaveProfileTool(USER_ID, vi.fn());

    // The LLM tool-call path has no transcript. Writing "" here would blank a
    // real record left by a prior engine-driven interview, so the key is absent.
    await profileTool.handler(validInput, undefined);

    const call = vi.mocked(prisma.profile.upsert).mock.calls[0][0];
    expect(call.update).not.toHaveProperty("rawTranscript");
    expect(call.create).not.toHaveProperty("rawTranscript");
  });

  it("serializes the profile as JSON in structuredData", async () => {
    vi.mocked(prisma.profile.upsert).mockResolvedValue({
      id: PROFILE_ID,
      userId: USER_ID,
      rawTranscript: "",
      structuredData: "{}",
      status: "COMPLETED",
    });
    const profileTool = createSaveProfileTool(USER_ID, vi.fn());

    await profileTool.handler(validInput, undefined);

    const call = vi.mocked(prisma.profile.upsert).mock.calls[0][0];
    const stored = JSON.parse(call.create.structuredData as string);
    expect(stored.age).toBe(28);
    expect(stored.city).toBe("Tel Aviv");
    expect(stored.wants_kids).toBe(true);
    expect(stored.hobbies[0].name).toBe("hiking");
  });

  // #552: Phase 1 completion is an audit event — metadata only, none of the
  // profile's content.
  it("records an INTERVIEW_COMPLETED audit event for Phase 1", async () => {
    vi.mocked(prisma.profile.upsert).mockResolvedValue({
      id: PROFILE_ID,
      userId: USER_ID,
      rawTranscript: "",
      structuredData: "{}",
      status: "COMPLETED",
    });

    await persistProfile(USER_ID, validInput);

    expect(recordEvent).toHaveBeenCalledWith(
      "INTERVIEW_COMPLETED",
      { mode: "interview_self" },
      { userId: USER_ID }
    );
  });

  it('accepts "undecided" for wants_kids and stores it correctly', async () => {
    vi.mocked(prisma.profile.upsert).mockResolvedValue({
      id: PROFILE_ID,
      userId: USER_ID,
      rawTranscript: "",
      structuredData: "{}",
      status: "COMPLETED",
    });
    const profileTool = createSaveProfileTool(USER_ID, vi.fn());

    await profileTool.handler({ ...validInput, wants_kids: "undecided" }, undefined);

    const call = vi.mocked(prisma.profile.upsert).mock.calls[0][0];
    const stored = JSON.parse(call.create.structuredData as string);
    expect(stored.wants_kids).toBe("undecided");
  });
});
