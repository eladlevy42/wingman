import { afterEach, describe, expect, it, vi } from "vitest";
import { submitDecision } from "./decision";

const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const MATCH_ID = "9f1c0f7e-59a1-4a3f-9c7e-6d2a1b0e4c11";

interface Call {
  url: string;
  method?: string;
  body?: string;
}

function stubDecide(body: unknown, { ok = true, status = 200 } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method, body: init?.body });
      return { ok, status, json: async () => body };
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("submitDecision", () => {
  it("posts the decision to the match endpoint", async () => {
    const calls = stubDecide({ waiting: true });

    await submitDecision(MATCH_ID, USER_ID, "yeah");

    expect(calls[0].url).toContain("/api/match/decide");
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body ?? "{}")).toEqual({
      matchId: MATCH_ID,
      userId: USER_ID,
      decision: "yeah",
    });
  });

  // `waiting` is what tells the screen whether to hold on the pending state or
  // whether the other side has already answered.
  it("returns whether the match is still waiting on the other user", async () => {
    stubDecide({ waiting: false });

    expect(await submitDecision(MATCH_ID, USER_ID, "yeah")).toEqual({ waiting: false });
  });

  it("carries a nah through unchanged", async () => {
    const calls = stubDecide({ waiting: false });

    await submitDecision(MATCH_ID, USER_ID, "nah");

    expect(JSON.parse(calls[0].body ?? "{}").decision).toBe("nah");
  });

  // The difference from loadMatchReveal, and it is deliberate. A decision the
  // user believes they made but the server never recorded leaves them waiting
  // on a match that is not waiting on them, until the window expires and
  // auto-Nahs it. The screen has to be able to say so and offer a retry.
  it("throws when the api rejects the decision", async () => {
    stubDecide({ error: "Match not found" }, { ok: false, status: 404 });

    await expect(submitDecision(MATCH_ID, USER_ID, "yeah")).rejects.toThrow(/match not found/i);
  });

  it("throws when the api cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Network request failed");
      })
    );

    await expect(submitDecision(MATCH_ID, USER_ID, "yeah")).rejects.toThrow();
  });

  it("throws when the response does not match the schema", async () => {
    stubDecide({ waiting: "yes" });

    await expect(submitDecision(MATCH_ID, USER_ID, "yeah")).rejects.toThrow();
  });

  // Caught before the request rather than after: /state omits matchId when
  // nobody is matched, and posting an undefined one would come back as a 400
  // full of Zod issues instead of something the screen can act on.
  it("refuses to send a decision with no match, without calling the api", async () => {
    const calls = stubDecide({ waiting: true });

    await expect(submitDecision(undefined, USER_ID, "yeah")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
