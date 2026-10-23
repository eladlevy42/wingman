import { afterEach, describe, expect, it, vi } from "vitest";
import type { BlindDateResponse } from "@wingman/shared";
import { loadBlindDate, partnerSubline, personalityBlurb } from "./blindDate";

const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

type PartnerProfile = BlindDateResponse["partnerProfile"];

// The full shape, because loadBlindDate parses the response against the shared
// schema and a partial one is a contract failure rather than a fixture detail.
function profile(overrides: Partial<PartnerProfile> = {}): PartnerProfile {
  return {
    age: 28,
    city: "Tel Aviv",
    country: "Israel",
    height: null,
    job: "Architect",
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
    ...overrides,
  };
}

describe("personalityBlurb", () => {
  it("prefers conflict style", () => {
    expect(
      personalityBlurb(
        profile({ conflict_style: "head-on", emotional_openness: "Guarded at first" })
      )
    ).toBe("Handles conflict head-on.");
  });

  it("falls back to emotional openness", () => {
    expect(personalityBlurb(profile({ emotional_openness: "Guarded at first" }))).toBe(
      "Guarded at first with feelings."
    );
  });

  it("falls back again to how they treat people", () => {
    expect(personalityBlurb(profile({ treatment_of_others: "Generous" }))).toBe(
      "Generous with people."
    );
  });

  // The card omits the line rather than rendering an empty one. Every other
  // outcome puts a true sentence there, which is why the fallback chain exists
  // at all.
  it("gives nothing when the profile carries none of them", () => {
    expect(personalityBlurb(profile())).toBeNull();
  });
});

describe("partnerSubline", () => {
  it("joins age, city and job", () => {
    expect(partnerSubline(profile())).toBe("28 · Tel Aviv · Architect");
  });

  // A missing job must not leave a dangling separator.
  it("drops a field the profile does not carry", () => {
    expect(partnerSubline(profile({ job: null }))).toBe("28 · Tel Aviv");
  });

  it("drops a blank one too", () => {
    expect(partnerSubline(profile({ job: "   " }))).toBe("28 · Tel Aviv");
  });
});

const DATE_RESPONSE = {
  venue: "Port Sa'id",
  dateTime: "2026-09-03T19:30:00.000Z",
  partnerName: "Dana Cohen",
  partnerPhotoUrl: "data:image/jpeg;base64,/9j/partner",
  selfPhotoUrl: "data:image/jpeg;base64,/9j/self",
  partnerProfile: profile(),
};

function stubBlindDate(body: unknown, { ok = true, status = 200 } = {}) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      return { ok, status, json: async () => body };
    })
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadBlindDate", () => {
  it("reads the date for this user", async () => {
    const urls = stubBlindDate(DATE_RESPONSE);

    const date = await loadBlindDate(USER_ID);

    expect(urls[0]).toContain(`/api/users/${USER_ID}/blind-date`);
    expect(date.venue).toBe("Port Sa'id");
    expect(date.partnerName).toBe("Dana Cohen");
  });

  // The opposite of loadMatchReveal, and deliberately: this screen is nothing
  // but these fields, so there is no degraded version of it to fall back to.
  it("throws rather than degrading when the date cannot be read", async () => {
    stubBlindDate({ error: "No blind date found" }, { ok: false, status: 404 });

    await expect(loadBlindDate(USER_ID)).rejects.toThrow(/no blind date found/i);
  });

  it("throws when the api cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Network request failed");
      })
    );

    await expect(loadBlindDate(USER_ID)).rejects.toThrow();
  });
});
