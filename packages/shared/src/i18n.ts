import { z } from "zod";

// The interview's language layer. See docs/adr/0037-interview-runs-in-hebrew-by-default.md.
//
// Wingman is Israel-only by construction (registration is gated to Tel Aviv
// University addresses), so the interview runs in Hebrew by default and English
// is the opt-in. Only the *conversation* is localized — the structured profile
// the interview produces stays English-keyed with English values, so matching,
// negotiation and every schema downstream are untouched by the language choice.

export const InterviewLanguageSchema = z.enum(["he", "en"]);

export type InterviewLanguage = z.infer<typeof InterviewLanguageSchema>;

// Hebrew is the default for every new session (ADR-0037). A client that sends
// no language gets Hebrew, so the default lives on the server and the two
// clients cannot drift from it.
export const DEFAULT_INTERVIEW_LANGUAGE: InterviewLanguage = "he";

/**
 * How Hebrew copy addresses the person. English conjugates nothing, so this
 * only affects `he` copy. "plural" (אתם) is the neutral fallback — what a user
 * whose gender is "other" (or unknown) reads. Registration collects gender
 * before the interview ever starts, so male/female users get the direct
 * אתה/את forms. Shared so the api's interview copy and each client's own chat
 * copy address the same person the same way.
 */
export type AddressForm = "plural" | "masculine" | "feminine";

/** Maps the registration gender value to the Hebrew address form. */
export function addressFormForGender(gender: string | null | undefined): AddressForm {
  if (gender === "male") return "masculine";
  if (gender === "female") return "feminine";
  return "plural";
}

// The languages offered by the toggle, in display order. Shared so web and
// mobile render the same control.
export const INTERVIEW_LANGUAGE_OPTIONS: readonly {
  language: InterviewLanguage;
  flag: string;
  // The short all-caps code the toggle buttons show. Text rather than the flag:
  // a flag ties a language to one country, and the two are easier to tell apart
  // as codes at a glance.
  code: string;
  // The language's own name — a toggle that says "אנגלית" to a Hebrew reader is
  // harder to scan than one that says "English".
  label: string;
}[] = [
  { language: "he", flag: "🇮🇱", code: "HEB", label: "עברית" },
  { language: "en", flag: "🇬🇧", code: "ENG", label: "English" },
];

/** True when the language is written right-to-left. */
export function isRtl(language: InterviewLanguage): boolean {
  return language === "he";
}

/**
 * A string (or any value) that exists once per interview language.
 *
 * Both entries are required rather than optional: a missing translation should
 * be a type error at authoring time, not an English string leaking into a
 * Hebrew interview at runtime.
 */
export type Localized<T> = Record<InterviewLanguage, T>;

/** Picks the entry for `language` out of a Localized value. */
export function localize<T>(value: Localized<T>, language: InterviewLanguage): T {
  return value[language];
}

// The chat surface's own copy — everything the two BarneyChat components render
// that does not come from the server. Kept here rather than in each client so
// the RN and web chats cannot drift, exactly as MAX_MESSAGE_LENGTH is.
export interface ChatUiStrings {
  // Barney's name as the label over his bubbles; Hebrew spells it ברני.
  barneyName: string;
  barneyTyping: string;
  back: string;
  backAccessibility: string;
  defaultSectionTitle: string;
  jumpToLatest: string;
  typeYourMessage: string;
  orInYourOwnWords: string;
  anythingElseAddItHere: string;
  pickAsManyAsYouLike: string;
  selectedCount: (count: number) => string;
  send: string;
  messageInput: string;
  yourAge: string;
  yourHeight: string;
  lengthLimitSuffix: string;
  lengthLimitAnnouncement: (max: number) => string;
  languageToggleAccessibility: string;
}

export const CHAT_UI_STRINGS: Localized<ChatUiStrings> = {
  en: {
    barneyName: "Barney",
    barneyTyping: "Barney is typing",
    back: "Back",
    backAccessibility: "Go back to the previous question",
    defaultSectionTitle: "Getting to know you",
    jumpToLatest: "Jump to latest",
    typeYourMessage: "Type your message...",
    orInYourOwnWords: "…or say it in your own words",
    anythingElseAddItHere: "…anything else? add it here",
    pickAsManyAsYouLike: "Pick as many as you like",
    selectedCount: (count) => `${count} selected`,
    send: "Send",
    messageInput: "Message input",
    yourAge: "Your age",
    yourHeight: "Your height",
    lengthLimitSuffix: " — that's the limit, keep it shorter",
    lengthLimitAnnouncement: (max) => `Message length limit reached, ${max} characters.`,
    languageToggleAccessibility: "Interview language",
  },
  he: {
    barneyName: "ברני",
    barneyTyping: "ברני מקליד",
    back: "חזרה",
    backAccessibility: "חזרה לשאלה הקודמת",
    defaultSectionTitle: "מכירים אותך",
    jumpToLatest: "לחדש ביותר",
    typeYourMessage: "כתבו את התשובה שלכם...",
    orInYourOwnWords: "…או במילים שלכם",
    anythingElseAddItHere: "…משהו נוסף? הוסיפו כאן",
    pickAsManyAsYouLike: "בחרו כמה שתרצו",
    selectedCount: (count) => `${count} נבחרו`,
    send: "שליחה",
    messageInput: "תיבת הודעה",
    yourAge: "הגיל שלך",
    yourHeight: "הגובה שלך",
    lengthLimitSuffix: " — זו התקרה, נסו לקצר",
    lengthLimitAnnouncement: (max) => `הגעתם למגבלת האורך, ${max} תווים.`,
    languageToggleAccessibility: "שפת הריאיון",
  },
};

// Singular-address strings that read identically whether the person is
// addressed as masculine or feminine ("שלך" carries no gender on its own) —
// written once and merged into both entries below, rather than repeated.
const HEBREW_ADDRESSED_SINGULAR: Partial<ChatUiStrings> = {
  orInYourOwnWords: "…או במילים שלך",
  lengthLimitAnnouncement: (max) => `הגעת למגבלת האורך, ${max} תווים.`,
};

// The Hebrew chat copy that conjugates by who is being addressed. CHAT_UI_STRINGS.he
// is the neutral plural; these override only the keys that differ, so a string
// that reads the same for everyone ("הגיל שלך") is written once.
const HEBREW_ADDRESSED: Record<Exclude<AddressForm, "plural">, Partial<ChatUiStrings>> = {
  masculine: {
    ...HEBREW_ADDRESSED_SINGULAR,
    typeYourMessage: "כתוב את התשובה שלך...",
    anythingElseAddItHere: "…משהו נוסף? הוסף כאן",
    pickAsManyAsYouLike: "בחר כמה שתרצה",
    lengthLimitSuffix: " — זו התקרה, נסה לקצר",
  },
  feminine: {
    ...HEBREW_ADDRESSED_SINGULAR,
    typeYourMessage: "כתבי את התשובה שלך...",
    anythingElseAddItHere: "…משהו נוסף? הוסיפי כאן",
    pickAsManyAsYouLike: "בחרי כמה שתרצי",
    lengthLimitSuffix: " — זו התקרה, נסי לקצר",
  },
};

// The key both clients store the user's language choice under. Shared so the
// two cannot drift, and named after the app so it cannot collide with anything
// else in localStorage / AsyncStorage.
export const INTERVIEW_LANGUAGE_STORAGE_KEY = "wingman.interviewLanguage";

/**
 * Reads a stored language choice, falling back to the default for anything
 * missing or unrecognized.
 *
 * Pure, and shared rather than written twice, so "a corrupt stored value starts
 * the interview in Hebrew rather than crashing you" is one testable rule across
 * both clients — the same shape as parseStoredBarneySession.
 */
export function parseStoredLanguage(raw: string | null | undefined): InterviewLanguage {
  const parsed = InterviewLanguageSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_INTERVIEW_LANGUAGE;
}

/**
 * The chat copy for a language, conjugated for the person it addresses. The
 * address only matters in Hebrew; an unknown gender keeps the neutral plural.
 */
export function chatStrings(
  language: InterviewLanguage,
  address: AddressForm = "plural"
): ChatUiStrings {
  if (language !== "he" || address === "plural") return CHAT_UI_STRINGS[language];
  return { ...CHAT_UI_STRINGS.he, ...HEBREW_ADDRESSED[address] };
}
