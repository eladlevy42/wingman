import { describe, expect, it, vi, beforeEach } from "vitest";
import { getBlindDate, BlindDateNotFoundError } from "./blindDate.service";
import { NotFoundError } from "./user.service";

vi.mock("@wingman/database", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    match: {
      findFirst: vi.fn(),
    },
  },
}));

import { prisma } from "@wingman/database";

const PARTNER_PROFILE = {
  age: 29,
  city: "Tel Aviv",
  country: "Israel",
  height: null,
  job: null,
  hometown: null,
  education: null,
  body_type: null,
  conflict_style: null,
  emotional_openness: null,
  treatment_of_others: null,
  personality_traits: [],
  wants_kids: null,
  kids_timeline: null,
  faith: null,
  current_motivation: null,
  life_vision: null,
  hobbies: [],
  typical_weekend: null,
  social_energy: null,
  social_circle: null,
  photoUrls: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getBlindDate", () => {
  it("returns venue, dateTime, partner name/photo, and the partner's revealed profile", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({ id: "user-a", photoUrl: "data:image/png;base64,self123" } as never)
      .mockResolvedValueOnce({
        id: "user-b",
        name: "Sarah",
        photoUrl: "data:image/png;base64,abc123",
        profile: { structuredData: JSON.stringify(PARTNER_PROFILE) },
      } as never);
    vi.mocked(prisma.match.findFirst).mockResolvedValue({
      id: "match-1",
      userAId: "user-a",
      userBId: "user-b",
      venue: "Aroma Coffee",
      dateTime: new Date("2026-01-04T20:00:00Z"),
    } as never);

    const result = await getBlindDate("user-a");

    expect(result).toEqual({
      venue: "Aroma Coffee",
      dateTime: "2026-01-04T20:00:00.000Z",
      partnerName: "Sarah",
      partnerPhotoUrl: "data:image/png;base64,abc123",
      selfPhotoUrl: "data:image/png;base64,self123",
      partnerProfile: PARTNER_PROFILE,
    });
  });

  it("throws NotFoundError when the user does not exist", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    await expect(getBlindDate("missing-user")).rejects.toThrow(NotFoundError);
  });

  it("throws BlindDateNotFoundError when no resolved match exists", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "user-a" } as never);
    vi.mocked(prisma.match.findFirst).mockResolvedValue(null);

    await expect(getBlindDate("user-a")).rejects.toThrow(BlindDateNotFoundError);
  });

  it("throws BlindDateNotFoundError and logs a data-integrity error when the partner has no profile", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({ id: "user-a" } as never)
      .mockResolvedValueOnce({ id: "user-b", profile: null } as never);
    vi.mocked(prisma.match.findFirst).mockResolvedValue({
      id: "match-1",
      userAId: "user-a",
      userBId: "user-b",
      venue: "Aroma Coffee",
      dateTime: new Date("2026-01-04T20:00:00Z"),
    } as never);

    await expect(getBlindDate("user-a")).rejects.toThrow(BlindDateNotFoundError);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("match-1"));
    consoleError.mockRestore();
  });

  it("throws BlindDateNotFoundError and logs a data-integrity error when the partner has no photoUrl", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce({ id: "user-a" } as never)
      .mockResolvedValueOnce({
        id: "user-b",
        name: "Sarah",
        photoUrl: null,
        profile: { structuredData: JSON.stringify(PARTNER_PROFILE) },
      } as never);
    vi.mocked(prisma.match.findFirst).mockResolvedValue({
      id: "match-1",
      userAId: "user-a",
      userBId: "user-b",
      venue: "Aroma Coffee",
      dateTime: new Date("2026-01-04T20:00:00Z"),
    } as never);

    await expect(getBlindDate("user-a")).rejects.toThrow(BlindDateNotFoundError);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("match-1"));
    consoleError.mockRestore();
  });
});
