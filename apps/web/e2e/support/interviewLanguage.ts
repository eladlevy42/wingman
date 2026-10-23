import type { Page } from "@playwright/test";
// Deliberately not imported from @wingman/shared: Playwright loads these specs
// as ESM under plain Node, where that package resolves to its CommonJS build
// and named exports are not available. The value must stay in step with
// INTERVIEW_LANGUAGE_STORAGE_KEY in packages/shared/src/i18n.ts — if it drifts,
// every spec below silently stops pinning the language and fails on Hebrew copy,
// which is a loud failure rather than a silent one.
const INTERVIEW_LANGUAGE_STORAGE_KEY = "wingman.interviewLanguage";

type InterviewLanguage = "he" | "en";

/**
 * Pins the interview to one language for a spec.
 *
 * The interview runs in Hebrew by default (ADR-0037), and the chat surface's
 * own copy — the composer placeholder, the Send label, "Pick as many as you
 * like" — follows it. Every spec written before #531 selects on the English
 * copy while testing something else entirely: the composer's length cap, the
 * mid-reveal lock, scroll pinning, a truncated stream.
 *
 * Rather than re-writing those selectors in Hebrew — which would say nothing
 * about what each spec is actually for — they pin the language to English and
 * keep reading as before. The Hebrew default and the toggle have their own
 * coverage in interview-language-531.spec.ts.
 *
 * Runs as an init script so it lands before the app's first render, which is
 * when the language is read and the session opened.
 */
export async function pinInterviewLanguage(
  page: Page,
  language: InterviewLanguage = "en"
): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [INTERVIEW_LANGUAGE_STORAGE_KEY, language]
  );
}
