import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PROPOSED_SLOTS,
  formatDateTime,
  formatSlot,
  maxSelectFor,
  offeredSlots,
  submitAvailability,
  toggleSlot,
} from "./schedule";

const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const MATCH_ID = "9f1c0f7e-59a1-4a3f-9c7e-6d2a1b0e4c11";

const A = "2026-09-03T19:30:00.000Z";
const B = "2026-09-04T19:30:00.000Z";
const C = "2026-09-05T19:30:00.000Z";
const D = "2026-09-06T19:30:00.000Z";

describe("roles and what each is choosing between", () => {
  it("lets the proposer forward three slots", () => {
    expect(maxSelectFor("proposer")).toBe(MAX_PROPOSED_SLOTS);
  });

  it("lets the chooser pick exactly one", () => {
    expect(maxSelectFor("chooser")).toBe(1);
  });

  // The safe direction while the role is still loading: the chooser's single
  // pick is what locks in a date, and offering three boxes to someone who may
  // only tick one would be a promise the api rejects.
  it("treats an unknown role as the chooser", () => {
    expect(maxSelectFor(null)).toBe(1);
  });

  it("offers the proposer the whole candidate slate", () => {
    expect(offeredSlots("proposer", [A, B, C], [])).toEqual([A, B, C]);
  });

  it("offers the chooser only what the proposer forwarded", () => {
    expect(offeredSlots("chooser", [A, B, C, D], [A, C])).toEqual([A, C]);
  });

  // What puts the chooser on the waiting state rather than an empty picker.
  it("offers the chooser nothing until the proposer has picked", () => {
    expect(offeredSlots("chooser", [A, B, C], [])).toEqual([]);
  });
});

describe("toggleSlot", () => {
  it("selects a slot that was not selected", () => {
    expect(toggleSlot([], A, 3)).toEqual([A]);
  });

  it("deselects a slot that was", () => {
    expect(toggleSlot([A, B], A, 3)).toEqual([B]);
  });

  // Nothing can get stuck on: a selected slot is always removable, even at the
  // limit, which is the only way back from a full selection.
  it("deselects at the limit too", () => {
    expect(toggleSlot([A, B, C], B, 3)).toEqual([A, C]);
  });

  it("keeps the proposer to three", () => {
    expect(toggleSlot([A, B, C], D, 3)).toEqual([A, B, C]);
  });

  // The deliberate split from the three-slot behaviour. A radio group that
  // silently ignores taps once something is chosen feels broken, so a single
  // pick replaces rather than being refused.
  it("replaces the chooser's pick rather than ignoring the tap", () => {
    expect(toggleSlot([A], B, 1)).toEqual([B]);
  });

  it("lets the chooser clear their pick", () => {
    expect(toggleSlot([A], A, 1)).toEqual([]);
  });

  it("does not mutate the selection it was given", () => {
    const selected = [A, B];
    toggleSlot(selected, C, 3);
    expect(selected).toEqual([A, B]);
  });
});

describe("formatting a slot", () => {
  // Built from a local-time constructor rather than an ISO string with a Z, so
  // the expectation does not depend on the machine's timezone — the formatter
  // reads local getters, which is what a user comparing this against their own
  // calendar needs it to do.
  const localEvening = new Date(2026, 8, 3, 19, 30).toISOString();
  const localMorning = new Date(2026, 8, 3, 9, 5).toISOString();

  it("gives a short weekday, month and day", () => {
    expect(formatSlot(localEvening).day).toBe("Thu, Sep 3");
  });

  it("gives a 12-hour time with a padded minute", () => {
    expect(formatSlot(localEvening).time).toBe("7:30 PM");
    expect(formatSlot(localMorning).time).toBe("9:05 AM");
  });

  it("renders midnight and midday as 12, not 0", () => {
    expect(formatSlot(new Date(2026, 8, 3, 0, 0).toISOString()).time).toBe("12:00 AM");
    expect(formatSlot(new Date(2026, 8, 3, 12, 0).toISOString()).time).toBe("12:00 PM");
  });

  it("puts the same instant on one line for the date card", () => {
    expect(formatDateTime(localEvening)).toBe("Thu, Sep 3 · 7:30 PM");
  });
});

interface Call {
  url: string;
  method?: string;
  body?: string;
}

function stubAvailability(body: unknown, { ok = true, status = 200 } = {}) {
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

describe("submitAvailability", () => {
  it("posts the selected slots", async () => {
    const calls = stubAvailability({ waiting: true, matchingState: "CHOOSING_TIMES" });

    await submitAvailability(MATCH_ID, USER_ID, [A, B]);

    expect(calls[0].url).toContain("/api/match/availability");
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body ?? "{}")).toEqual({
      matchId: MATCH_ID,
      userId: USER_ID,
      slots: [A, B],
    });
  });

  // How the screen tells the proposer's submission from the chooser's: only the
  // chooser's pick writes the venue and moves both users on.
  it("reports the state the submission produced", async () => {
    stubAvailability({ waiting: false, matchingState: "DATE_ASSIGNED" });

    const result = await submitAvailability(MATCH_ID, USER_ID, [A]);

    expect(result.matchingState).toBe("DATE_ASSIGNED");
  });

  it("throws when the api rejects the slots", async () => {
    stubAvailability({ error: "Slot not offered" }, { ok: false, status: 400 });

    await expect(submitAvailability(MATCH_ID, USER_ID, [A])).rejects.toThrow(/slot not offered/i);
  });

  it("throws when the api cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Network request failed");
      })
    );

    await expect(submitAvailability(MATCH_ID, USER_ID, [A])).rejects.toThrow();
  });

  // Both caught before the request, by the shared schema the api validates
  // against — an empty selection and a fourth slot are the two the UI is
  // already supposed to prevent, and this is the backstop.
  it("refuses to send an empty selection without calling the api", async () => {
    const calls = stubAvailability({ waiting: true, matchingState: "CHOOSING_TIMES" });

    await expect(submitAvailability(MATCH_ID, USER_ID, [])).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("refuses to send more slots than the api accepts", async () => {
    const calls = stubAvailability({ waiting: true, matchingState: "CHOOSING_TIMES" });

    await expect(submitAvailability(MATCH_ID, USER_ID, [A, B, C, D])).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("refuses to send a submission with no match", async () => {
    const calls = stubAvailability({ waiting: true, matchingState: "CHOOSING_TIMES" });

    await expect(submitAvailability(undefined, USER_ID, [A])).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
