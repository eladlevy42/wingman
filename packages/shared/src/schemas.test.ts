import { describe, expect, it } from "vitest";
import { ChatMessageSchema, ProfileSchema, SendMessageSchema } from "./schemas";

const validProfile = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  userId: "550e8400-e29b-41d4-a716-446655440001",
  rawTranscript: "hello",
  structuredData: null,
  status: "INCOMPLETE",
};

describe("ProfileSchema", () => {
  it("parses a valid profile", () => {
    expect(() => ProfileSchema.parse(validProfile)).not.toThrow();
  });

  it("throws ZodError on a rawTranscript over the max length", () => {
    expect(() =>
      ProfileSchema.parse({ ...validProfile, rawTranscript: "a".repeat(50_001) })
    ).toThrow();
  });
});

describe("ChatMessageSchema", () => {
  it("parses a valid chat message", () => {
    expect(() => ChatMessageSchema.parse({ role: "user", content: "hi" })).not.toThrow();
  });

  it("throws ZodError on content over the max length", () => {
    expect(() => ChatMessageSchema.parse({ role: "user", content: "a".repeat(4001) })).toThrow();
  });
});

describe("SendMessageSchema", () => {
  const validInput = { userId: "550e8400-e29b-41d4-a716-446655440000", message: "hi" };

  it("parses a valid input", () => {
    expect(() => SendMessageSchema.parse(validInput)).not.toThrow();
  });

  it("throws ZodError on a message over the max length", () => {
    expect(() => SendMessageSchema.parse({ ...validInput, message: "a".repeat(4001) })).toThrow();
  });
});
