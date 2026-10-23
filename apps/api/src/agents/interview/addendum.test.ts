import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRunAgentQuery } = vi.hoisted(() => ({ mockRunAgentQuery: vi.fn() }));

vi.mock("../agentSdkClient", async (importActual) => {
  const actual = await importActual<typeof import("../agentSdkClient")>();
  return { ...actual, runAgentQuery: mockRunAgentQuery };
});

import { INTERVIEW_HELPER_MODEL } from "../models";
import { parseAddendumResult, routeAddendum } from "./addendum";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseAddendumResult", () => {
  it("parses a none result", () => {
    expect(parseAddendumResult('{"kind": "none"}')).toEqual({
      kind: "none",
      field: undefined,
      value: undefined,
    });
  });

  it("parses an existing_field result", () => {
    const result = parseAddendumResult(
      '{"kind": "existing_field", "field": "city", "value": "Haifa"}'
    );
    expect(result).toEqual({ kind: "existing_field", field: "city", value: "Haifa" });
  });

  it("parses a new_note result", () => {
    const result = parseAddendumResult('{"kind": "new_note", "value": "Allergic to cats."}');
    expect(result).toEqual({ kind: "new_note", field: undefined, value: "Allergic to cats." });
  });

  it("tolerates JSON wrapped in stray prose", () => {
    const result = parseAddendumResult('Sure thing: {"kind": "none"} hope that helps');
    expect(result.kind).toBe("none");
  });

  it("throws when there is no JSON object", () => {
    expect(() => parseAddendumResult("totally not json")).toThrow(/no JSON object/);
  });

  it("throws on an unrecognized kind", () => {
    expect(() => parseAddendumResult('{"kind": "something_else"}')).toThrow(/malformed/);
  });

  it("drops a new_note with a non-string value to none", () => {
    const result = parseAddendumResult('{"kind": "new_note", "value": {"nested": true}}');
    expect(result).toEqual({ kind: "none", field: undefined, value: undefined });
  });

  it("drops a new_note with a missing value to none", () => {
    const result = parseAddendumResult('{"kind": "new_note"}');
    expect(result).toEqual({ kind: "none", field: undefined, value: undefined });
  });

  it("drops an existing_field with a missing value to none", () => {
    const result = parseAddendumResult('{"kind": "existing_field", "field": "job"}');
    expect(result).toEqual({ kind: "none", field: undefined, value: undefined });
  });
});

describe("routeAddendum", () => {
  it("parses the agent query's text into an AddendumResult", async () => {
    mockRunAgentQuery.mockResolvedValueOnce({
      text: '{"kind": "existing_field", "field": "city", "value": "Haifa"}',
      toolUses: [],
    });

    const result = await routeAddendum({
      answer: "actually I moved to Haifa",
      language: "en",
      fields: [{ field: "city", text: "Which city?", currentValue: "Tel Aviv" }],
      userId: "u-1",
    });

    expect(result).toEqual({ kind: "existing_field", field: "city", value: "Haifa" });
    expect(mockRunAgentQuery).toHaveBeenCalledWith(
      expect.objectContaining({ logLabel: "addendum", model: INTERVIEW_HELPER_MODEL })
    );
  });

  it("propagates errors from the agent query", async () => {
    mockRunAgentQuery.mockRejectedValueOnce(new Error("network timeout"));

    await expect(
      routeAddendum({ answer: "nothing else", language: "en", fields: [], userId: "u-1" })
    ).rejects.toThrow("network timeout");
  });
});
