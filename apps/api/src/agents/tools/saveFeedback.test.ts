import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@wingman/database", () => ({
  prisma: {
    feedbackRound: {
      upsert: vi.fn(),
    },
  },
}));

import { prisma } from "@wingman/database";
import { persistFeedback, createSaveFeedbackTool } from "./saveFeedback";

const USER_ID = "123e4567-e89b-12d3-a456-426614174000";
const MATCH_ID = "ccc00000-e89b-12d3-a456-426614174000";
const FEEDBACK_ROUND_ID = "ddd00000-e89b-12d3-a456-426614174000";
const RAW_TRANSCRIPT = "User: It was fine.\n\nAssistant: Fine how?";

const validDelta = {
  addedDealbreakers: ["always 20 minutes late"],
  removedDealbreakers: [],
  removedPreferences: ["loves the outdoors"],
  addedPreferences: ["asks follow-up questions"],
  compromiseUpdates: ["shorter than I usually go for"],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.feedbackRound.upsert).mockResolvedValue({
    id: FEEDBACK_ROUND_ID,
    userId: USER_ID,
    matchId: MATCH_ID,
    rawTranscript: RAW_TRANSCRIPT,
    delta: JSON.stringify(validDelta),
    createdAt: new Date(),
  });
});

describe("persistFeedback", () => {
  it("upserts a FeedbackRound with userId, matchId, rawTranscript, and the serialized delta", async () => {
    const result = await persistFeedback(USER_ID, MATCH_ID, RAW_TRANSCRIPT, validDelta);

    expect(prisma.feedbackRound.upsert).toHaveBeenCalledWith({
      where: { userId_matchId: { userId: USER_ID, matchId: MATCH_ID } },
      update: {
        rawTranscript: RAW_TRANSCRIPT,
        delta: JSON.stringify(validDelta),
      },
      create: {
        userId: USER_ID,
        matchId: MATCH_ID,
        rawTranscript: RAW_TRANSCRIPT,
        delta: JSON.stringify(validDelta),
      },
    });
    expect(result).toEqual({ success: true, feedbackRoundId: FEEDBACK_ROUND_ID });
  });

  it("accepts a delta with all-empty arrays", async () => {
    const emptyDelta = {
      addedDealbreakers: [],
      removedDealbreakers: [],
      removedPreferences: [],
      addedPreferences: [],
      compromiseUpdates: [],
    };

    await persistFeedback(USER_ID, MATCH_ID, RAW_TRANSCRIPT, emptyDelta);

    const call = vi.mocked(prisma.feedbackRound.upsert).mock.calls[0][0];
    expect(JSON.parse(call.create.delta)).toEqual(emptyDelta);
  });

  it("does not throw on a second call for the same userId/matchId, and re-upserts instead of crashing", async () => {
    await persistFeedback(USER_ID, MATCH_ID, RAW_TRANSCRIPT, validDelta);
    await expect(persistFeedback(USER_ID, MATCH_ID, RAW_TRANSCRIPT, validDelta)).resolves.toEqual({
      success: true,
      feedbackRoundId: FEEDBACK_ROUND_ID,
    });

    expect(prisma.feedbackRound.upsert).toHaveBeenCalledTimes(2);
  });

  it("throws ZodError and does not touch prisma when a field is missing", async () => {
    const missingField: Record<string, unknown> = { ...validDelta };
    delete missingField.addedDealbreakers;

    await expect(
      persistFeedback(USER_ID, MATCH_ID, RAW_TRANSCRIPT, missingField)
    ).rejects.toThrow();
    expect(prisma.feedbackRound.upsert).not.toHaveBeenCalled();
  });

  it("throws ZodError and does not touch prisma when a field is not an array of strings", async () => {
    await expect(
      persistFeedback(USER_ID, MATCH_ID, RAW_TRANSCRIPT, {
        ...validDelta,
        addedDealbreakers: "late",
      })
    ).rejects.toThrow();
    expect(prisma.feedbackRound.upsert).not.toHaveBeenCalled();
  });
});

describe("createSaveFeedbackTool", () => {
  it("is named saveFeedback and lists exactly the five FeedbackDelta fields in its schema shape", () => {
    const feedbackTool = createSaveFeedbackTool(USER_ID, MATCH_ID, RAW_TRANSCRIPT, vi.fn());

    expect(feedbackTool.name).toBe("saveFeedback");
    expect(Object.keys(feedbackTool.inputSchema)).toEqual([
      "addedDealbreakers",
      "removedDealbreakers",
      "removedPreferences",
      "addedPreferences",
      "compromiseUpdates",
    ]);
  });

  it("persists the delta with the closed-over matchId/rawTranscript, then calls onSaved", async () => {
    const onSaved = vi.fn();
    const feedbackTool = createSaveFeedbackTool(USER_ID, MATCH_ID, RAW_TRANSCRIPT, onSaved);

    const result = await feedbackTool.handler(validDelta, undefined);

    expect(prisma.feedbackRound.upsert).toHaveBeenCalledWith({
      where: { userId_matchId: { userId: USER_ID, matchId: MATCH_ID } },
      update: {
        rawTranscript: RAW_TRANSCRIPT,
        delta: JSON.stringify(validDelta),
      },
      create: {
        userId: USER_ID,
        matchId: MATCH_ID,
        rawTranscript: RAW_TRANSCRIPT,
        delta: JSON.stringify(validDelta),
      },
    });
    expect(onSaved).toHaveBeenCalledWith(validDelta, {
      success: true,
      feedbackRoundId: FEEDBACK_ROUND_ID,
    });
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: true, feedbackRoundId: FEEDBACK_ROUND_ID }),
        },
      ],
    });
  });
});
