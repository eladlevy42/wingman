import { describe, expect, it } from "vitest";
import { FeedbackDeltaSchema } from "./feedback";

const validDelta = {
  addedDealbreakers: ["smoking"],
  removedPreferences: ["tall"],
  addedPreferences: ["dog person"],
  compromiseUpdates: ["open to long distance for the right person"],
};

describe("FeedbackDeltaSchema", () => {
  it("parses a valid delta without error", () => {
    expect(() => FeedbackDeltaSchema.parse(validDelta)).not.toThrow();
  });

  it("parses a delta with all-empty arrays", () => {
    expect(() =>
      FeedbackDeltaSchema.parse({
        addedDealbreakers: [],
        removedPreferences: [],
        addedPreferences: [],
        compromiseUpdates: [],
      })
    ).not.toThrow();
  });

  it("throws ZodError when a field is missing", () => {
    const missingField: Record<string, unknown> = { ...validDelta };
    delete missingField.addedDealbreakers;
    expect(() => FeedbackDeltaSchema.parse(missingField)).toThrow();
  });

  it("throws ZodError when a field is not an array of strings", () => {
    expect(() =>
      FeedbackDeltaSchema.parse({ ...validDelta, addedDealbreakers: "smoking" })
    ).toThrow();
  });

  it("throws ZodError when an array contains a non-string", () => {
    expect(() => FeedbackDeltaSchema.parse({ ...validDelta, compromiseUpdates: [123] })).toThrow();
  });

  // Issue #341: removedDealbreakers defaults to [] so a FeedbackRound
  // persisted before this field existed still parses.
  it("defaults removedDealbreakers to an empty array when omitted", () => {
    const result = FeedbackDeltaSchema.parse(validDelta);
    expect(result.removedDealbreakers).toEqual([]);
  });

  it("accepts an explicit removedDealbreakers list", () => {
    const result = FeedbackDeltaSchema.parse({ ...validDelta, removedDealbreakers: ["lateness"] });
    expect(result.removedDealbreakers).toEqual(["lateness"]);
  });
});
