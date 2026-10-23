import { useCallback, useState } from "react";
import {
  INTERVIEW_LANGUAGE_STORAGE_KEY,
  parseStoredLanguage,
  type InterviewLanguage,
} from "@wingman/shared";

/**
 * The interview language, persisted in localStorage so the choice survives a
 * reload (ADR-0037).
 *
 * Read synchronously on first render rather than in an effect: the interview
 * opens a session immediately, and that request has to carry the right language
 * — a one-render flash of the default would start the whole conversation in it.
 *
 * Every access is wrapped: localStorage throws outright in a private-mode
 * Safari window and in some embedded webviews, and a language preference is
 * never worth taking the interview down for.
 */
export function useInterviewLanguage(): [InterviewLanguage, (next: InterviewLanguage) => void] {
  const [language, setLanguageState] = useState<InterviewLanguage>(() => {
    try {
      return parseStoredLanguage(window.localStorage.getItem(INTERVIEW_LANGUAGE_STORAGE_KEY));
    } catch {
      return parseStoredLanguage(null);
    }
  });

  const setLanguage = useCallback((next: InterviewLanguage) => {
    setLanguageState(next);
    try {
      window.localStorage.setItem(INTERVIEW_LANGUAGE_STORAGE_KEY, next);
    } catch {
      // Ignored — see above. The choice still applies to this session.
    }
  }, []);

  return [language, setLanguage];
}
