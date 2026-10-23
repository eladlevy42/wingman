import { describe, expect, it } from "vitest";
import { UserProfileSchema } from "@wingman/shared";
import { buildSeedUsers, type SeedUser } from "./seedData";
import { buildSeedTranscripts } from "./seedTranscripts";

describe("buildSeedTranscripts", () => {
  const users: SeedUser[] = buildSeedUsers(500);
  const transcripts = buildSeedTranscripts(users);

  it("seeds one synthetic transcript", () => {
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]?.rawTranscript).toContain("[redacted]");
  });

  it("produces expectedStructuredProfile JSON that validates against UserProfileSchema", () => {
    for (const transcript of transcripts) {
      expect(() =>
        UserProfileSchema.parse(JSON.parse(transcript.expectedStructuredProfile))
      ).not.toThrow();
    }
  });

  it("assigns every transcript to a userId present in the seeded population", () => {
    const seededIds = new Set(users.map((user) => user.id));
    for (const transcript of transcripts) {
      expect(seededIds.has(transcript.userId)).toBe(true);
    }
  });

  it("throws when the seeded population is empty", () => {
    expect(() => buildSeedTranscripts([])).toThrow(/at least one seeded user/);
  });
});
