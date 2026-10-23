import { describe, it, expect } from "vitest";
import {
  CHAT_UI_STRINGS,
  DEFAULT_INTERVIEW_LANGUAGE,
  INTERVIEW_LANGUAGE_OPTIONS,
  addressFormForGender,
  chatStrings,
  isRtl,
  localize,
  parseStoredLanguage,
} from "./i18n";

describe("interview language", () => {
  it("defaults to Hebrew — Wingman is Israel-only by construction (ADR-0037)", () => {
    expect(DEFAULT_INTERVIEW_LANGUAGE).toBe("he");
  });

  it("treats Hebrew as right-to-left and English as left-to-right", () => {
    expect(isRtl("he")).toBe(true);
    expect(isRtl("en")).toBe(false);
  });

  it("offers exactly the two languages, each with a flag", () => {
    expect(INTERVIEW_LANGUAGE_OPTIONS.map((o) => o.language)).toEqual(["he", "en"]);
    for (const option of INTERVIEW_LANGUAGE_OPTIONS) {
      expect(option.flag.length).toBeGreaterThan(0);
      expect(option.label.length).toBeGreaterThan(0);
    }
  });
});

describe("parseStoredLanguage", () => {
  it("returns a stored, recognized language", () => {
    expect(parseStoredLanguage("en")).toBe("en");
    expect(parseStoredLanguage("he")).toBe("he");
  });

  it("falls back to the default for missing or unrecognized values", () => {
    // A corrupt stored value must start the interview in Hebrew, not crash the
    // screen that reads it.
    expect(parseStoredLanguage(null)).toBe("he");
    expect(parseStoredLanguage(undefined)).toBe("he");
    expect(parseStoredLanguage("")).toBe("he");
    expect(parseStoredLanguage("fr")).toBe("he");
    expect(parseStoredLanguage('{"language":"en"}')).toBe("he");
  });
});

describe("localize", () => {
  it("picks the entry for the requested language", () => {
    const value = { en: "Hello", he: "שלום" };
    expect(localize(value, "en")).toBe("Hello");
    expect(localize(value, "he")).toBe("שלום");
  });
});

describe("chat UI strings", () => {
  it("translates every key — a missing one would leak English into a Hebrew chat", () => {
    const en = CHAT_UI_STRINGS.en;
    const he = CHAT_UI_STRINGS.he;
    expect(Object.keys(he).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      const enValue = en[key];
      const heValue = he[key];
      expect(typeof heValue).toBe(typeof enValue);
      if (typeof enValue === "string" && typeof heValue === "string") {
        expect(heValue.length).toBeGreaterThan(0);
        expect(heValue).not.toBe(enValue);
      }
    }
  });

  it("renders the parameterized strings in the right language", () => {
    expect(chatStrings("en").selectedCount(3)).toBe("3 selected");
    expect(chatStrings("he").selectedCount(3)).toBe("3 נבחרו");
  });
});

describe("chat UI strings — addressing the person", () => {
  // Second-person plural forms, which a male or female user must never be shown.
  // Matched as whole words: JS's \b is ASCII-only, and "נבחרו" ("selected")
  // contains "בחרו" without addressing anyone.
  const PLURAL_YOU = /(?<![֐-׿])(אתם|שלכם|לכם|אתכם|תרצו|כתבו|בחרו|הוסיפו|נסו|הגעתם)(?![֐-׿])/;

  function allText(strings: ReturnType<typeof chatStrings>): string[] {
    return Object.values(strings).map((value) =>
      typeof value === "function" ? String(value(3)) : String(value)
    );
  }

  it.each(["masculine", "feminine"] as const)("uses no plural forms for a %s user", (address) => {
    for (const text of allText(chatStrings("he", address))) {
      expect(text).not.toMatch(PLURAL_YOU);
    }
  });

  it("conjugates the composer placeholder by gender", () => {
    expect(chatStrings("he", "masculine").typeYourMessage).toBe("כתוב את התשובה שלך...");
    expect(chatStrings("he", "feminine").typeYourMessage).toBe("כתבי את התשובה שלך...");
    expect(chatStrings("he", "plural").typeYourMessage).toBe(CHAT_UI_STRINGS.he.typeYourMessage);
  });

  it("keeps the strings that read the same for everyone", () => {
    expect(chatStrings("he", "feminine").yourAge).toBe(CHAT_UI_STRINGS.he.yourAge);
    expect(chatStrings("he", "masculine").barneyName).toBe("ברני");
  });

  it("ignores the address in English, which conjugates nothing", () => {
    expect(chatStrings("en", "feminine")).toBe(CHAT_UI_STRINGS.en);
  });

  it("maps registration gender to the address form, plural when unknown", () => {
    expect(addressFormForGender("male")).toBe("masculine");
    expect(addressFormForGender("female")).toBe("feminine");
    expect(addressFormForGender("other")).toBe("plural");
    expect(addressFormForGender(undefined)).toBe("plural");
  });
});
