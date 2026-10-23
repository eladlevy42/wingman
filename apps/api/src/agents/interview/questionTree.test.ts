import { t } from "./localized";
import { describe, it, expect } from "vitest";
import { extractLocation, extractHeight, extractAge, INTERVIEW_SELF_TREE } from "./questionTree";

describe("extractLocation", () => {
  it("returns a bare city name unchanged", () => {
    expect(extractLocation("Tel Aviv")).toEqual({ sufficient: true, value: "Tel Aviv" });
  });

  it("strips 'I live in' prefix", () => {
    expect(extractLocation("I live in Tel Aviv")).toEqual({ sufficient: true, value: "Tel Aviv" });
  });

  it("strips 'I'm from' prefix", () => {
    expect(extractLocation("I'm from London")).toEqual({ sufficient: true, value: "London" });
  });

  it("strips 'I am from' prefix", () => {
    expect(extractLocation("I am from Paris")).toEqual({ sufficient: true, value: "Paris" });
  });

  it("strips 'I'm based in' prefix", () => {
    expect(extractLocation("I'm based in New York City")).toEqual({
      sufficient: true,
      value: "New York City",
    });
  });

  it("strips 'I'm currently in' prefix", () => {
    expect(extractLocation("I'm currently in Berlin")).toEqual({
      sufficient: true,
      value: "Berlin",
    });
  });

  it("strips 'I grew up in' prefix", () => {
    expect(extractLocation("I grew up in Cleveland")).toEqual({
      sufficient: true,
      value: "Cleveland",
    });
  });

  it("strips 'I was born in' prefix", () => {
    expect(extractLocation("I was born in Tokyo")).toEqual({ sufficient: true, value: "Tokyo" });
  });

  it("strips 'It's in' prefix", () => {
    expect(extractLocation("It's in Israel")).toEqual({ sufficient: true, value: "Israel" });
  });

  it("strips 'It is in' prefix", () => {
    expect(extractLocation("It is in Germany")).toEqual({ sufficient: true, value: "Germany" });
  });

  it("takes only the part before the first comma", () => {
    expect(extractLocation("Tel Aviv, Israel")).toEqual({ sufficient: true, value: "Tel Aviv" });
  });

  it("strips prefix AND takes before comma together", () => {
    expect(extractLocation("I live in Tel Aviv, Israel")).toEqual({
      sufficient: true,
      value: "Tel Aviv",
    });
  });

  it("handles multi-word city names correctly", () => {
    expect(extractLocation("New York City, NY")).toEqual({
      sufficient: true,
      value: "New York City",
    });
  });

  it("marks a single-character answer insufficient", () => {
    expect(extractLocation("x")).toEqual({ sufficient: false, value: null });
  });

  it("marks an empty answer insufficient", () => {
    expect(extractLocation("")).toEqual({ sufficient: false, value: null });
  });

  it("marks a whitespace-only answer insufficient", () => {
    expect(extractLocation("   ")).toEqual({ sufficient: false, value: null });
  });

  it("marks off-topic prose insufficient rather than storing it (#228)", () => {
    expect(extractLocation("I love hiking and being outdoors on weekends")).toEqual({
      sufficient: false,
      value: null,
    });
    expect(extractLocation("honestly I would rather not say where I live")).toEqual({
      sufficient: false,
      value: null,
    });
  });

  it("still accepts a legitimate multi-word country name", () => {
    expect(extractLocation("United States of America")).toEqual({
      sufficient: true,
      value: "United States of America",
    });
  });

  it("marks short off-topic deflections insufficient even under the word cap (#228)", () => {
    expect(extractLocation("I don't know")).toEqual({ sufficient: false, value: null });
    expect(extractLocation("not sure")).toEqual({ sufficient: false, value: null });
    expect(extractLocation("why do you ask")).toEqual({ sufficient: false, value: null });
  });

  it("marks single-token chat abbreviations of a deflection insufficient (#409)", () => {
    expect(extractLocation("idk")).toEqual({ sufficient: false, value: null });
    expect(extractLocation("dunno")).toEqual({ sufficient: false, value: null });
    expect(extractLocation("n/a")).toEqual({ sufficient: false, value: null });
    expect(extractLocation("nvm")).toEqual({ sufficient: false, value: null });
  });

  it("still accepts legitimate short city/country abbreviations (#409)", () => {
    expect(extractLocation("NYC")).toEqual({ sufficient: true, value: "NYC" });
    expect(extractLocation("UK")).toEqual({ sufficient: true, value: "UK" });
    expect(extractLocation("LA")).toEqual({ sufficient: true, value: "LA" });
  });
});

describe("extractHeight", () => {
  it("returns a bare height string unchanged", () => {
    expect(extractHeight("5'11\"")).toEqual({ sufficient: true, value: "5'11\"" });
  });

  it("returns a metric height unchanged", () => {
    expect(extractHeight("180 cm")).toEqual({ sufficient: true, value: "180 cm" });
  });

  it("strips 'I'm' prefix", () => {
    expect(extractHeight("I'm 5'11\"")).toEqual({ sufficient: true, value: "5'11\"" });
  });

  it("strips 'I am' prefix", () => {
    expect(extractHeight("I am 180cm")).toEqual({ sufficient: true, value: "180cm" });
  });

  it("strips 'I'm about' prefix", () => {
    expect(extractHeight("I'm about 6 feet")).toEqual({ sufficient: true, value: "6 feet" });
  });

  it("strips 'about' prefix", () => {
    expect(extractHeight("about 180 cm")).toEqual({ sufficient: true, value: "180 cm" });
  });

  it("strips 'around' prefix", () => {
    expect(extractHeight("around 5'10\"")).toEqual({ sufficient: true, value: "5'10\"" });
  });

  it("strips 'roughly' prefix", () => {
    expect(extractHeight("roughly 175cm")).toEqual({ sufficient: true, value: "175cm" });
  });

  it("strips trailing 'tall'", () => {
    expect(extractHeight("6 feet tall")).toEqual({ sufficient: true, value: "6 feet" });
  });

  it("strips prefix and trailing 'tall' together", () => {
    expect(extractHeight("I'm about 5'11\" tall")).toEqual({ sufficient: true, value: "5'11\"" });
  });

  it("marks an empty answer insufficient", () => {
    expect(extractHeight("")).toEqual({ sufficient: false, value: null });
  });

  it("marks a single-character answer insufficient", () => {
    expect(extractHeight("5")).toEqual({ sufficient: false, value: null });
  });

  it("marks a numberless answer insufficient rather than storing it (#228)", () => {
    expect(extractHeight("pretty tall I guess")).toEqual({ sufficient: false, value: null });
    expect(extractHeight("who wants to know")).toEqual({ sufficient: false, value: null });
  });

  it("accepts a value from the height picker (cm with imperial label)", () => {
    expect(extractHeight("175 cm (5'9\")")).toEqual({ sufficient: true, value: "175 cm (5'9\")" });
  });

  it("marks a rambling sentence with an unrelated digit insufficient (#228)", () => {
    expect(extractHeight("I am 30 years old and love hiking")).toEqual({
      sufficient: false,
      value: null,
    });
  });
});

describe("extractAge", () => {
  it("accepts a plain age of 18 or older", () => {
    expect(extractAge("18")).toEqual({ sufficient: true, value: 18 });
    expect(extractAge("29")).toEqual({ sufficient: true, value: 29 });
    expect(extractAge("I'm 34 years old")).toEqual({ sufficient: true, value: 34 });
  });

  it("rejects an age under 18 (the previous bug accepted 13)", () => {
    expect(extractAge("13")).toEqual({ sufficient: false, value: null });
    expect(extractAge("I'm 16")).toEqual({ sufficient: false, value: null });
    expect(extractAge("17")).toEqual({ sufficient: false, value: null });
  });

  it("rejects an answer with no number", () => {
    expect(extractAge("old enough")).toEqual({ sufficient: false, value: null });
    expect(extractAge("")).toEqual({ sufficient: false, value: null });
  });

  it("rejects an implausibly high number", () => {
    expect(extractAge("200")).toEqual({ sufficient: false, value: null });
  });
});

describe("INTERVIEW_SELF_TREE — trimmed shape", () => {
  const fields = INTERVIEW_SELF_TREE.map((node) => node.field);

  it("no longer asks hometown or typical_weekend", () => {
    expect(fields).not.toContain("hometown");
    expect(fields).not.toContain("typical_weekend");
  });

  it("attaches an 18+ age picker to the age node", () => {
    const age = INTERVIEW_SELF_TREE.find((node) => node.field === "age");
    expect(age?.input).toEqual({ kind: "age", min: 18, max: 120 });
  });

  it("collects height via a scrolling height picker (#228)", () => {
    const height = INTERVIEW_SELF_TREE.find((node) => node.field === "height");
    expect(height?.kind).toBe("fact");
    expect(height?.input).toEqual({ kind: "height", minCm: 140, maxCm: 210 });
    // Not required — the profile schema allows a null height, so it must not
    // block completion if left unanswered.
    expect(height?.kind === "fact" && height.required).toBeFalsy();
  });

  it("offers Yes/No/Undecided choices for wants_kids", () => {
    const kids = INTERVIEW_SELF_TREE.find((node) => node.field === "wants_kids");
    expect(kids?.input?.kind).toBe("choice");
    if (kids?.input?.kind === "choice") {
      expect(kids.input.options.map((o) => t(o.label, "en"))).toEqual([
        "[redacted:en]",
        "[redacted:en]",
        "[redacted:en]",
      ]);
      expect(kids.input.allowFreeText).toBe(true);
    }
  });

  // #417 — shorten the interview: social_circle and body_type were cut
  // (overlapped social_energy and appearance respectively; neither field is
  // read by matching/negotiation), and faith became a chip picklist.
  // #530 reinstated body_type as a picklist by product decision; social_circle
  // stays cut.
  it("no longer asks social_circle (#417)", () => {
    expect(fields).not.toContain("social_circle");
  });

  it("asks body_type again, as a picklist with a free-text escape hatch (#530)", () => {
    expect(fields).toContain("body_type");
    const bodyType = INTERVIEW_SELF_TREE.find((node) => node.field === "body_type");
    expect(bodyType?.input?.kind).toBe("choice");
    if (bodyType?.input?.kind === "choice") {
      expect(bodyType.input.allowFreeText).toBe(true);
      expect(bodyType.input.options.length).toBeGreaterThan(0);
    }
  });

  // #530 — Wingman is Israel-only, so the country is filled from a constant in
  // assembleSelf rather than costing an interview turn.
  it("never asks which country (#530)", () => {
    expect(fields).not.toContain("country");
  });

  it("asks measurably fewer than the original 20 questions (#417)", () => {
    expect(INTERVIEW_SELF_TREE.length).toBeLessThan(20);
  });

  it("offers a chip picklist for faith with a free-text escape hatch (#417)", () => {
    const faith = INTERVIEW_SELF_TREE.find((node) => node.field === "faith");
    expect(faith?.input?.kind).toBe("choice");
    if (faith?.input?.kind === "choice") {
      expect(faith.input.allowFreeText).toBe(true);
      expect(faith.input.options.length).toBeGreaterThan(0);
    }
  });
});
