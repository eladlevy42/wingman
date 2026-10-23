import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  DEFAULT_INTERVIEW_LANGUAGE,
  INTERVIEW_LANGUAGE_STORAGE_KEY,
  parseStoredLanguage,
  type InterviewLanguage,
} from "@wingman/shared";

// The user's interview language, persisted so the choice survives an app
// restart (ADR-0037). Kept separate from the conversation snapshot in
// barneySession.ts: that is discarded the moment a phase completes, while the
// language choice should still hold when Phase 2 opens days later.

export { INTERVIEW_LANGUAGE_STORAGE_KEY };

/**
 * Reads the saved language, falling back to the default for anything missing,
 * corrupt, or unrecognized. Best-effort throughout — a storage failure must
 * never keep the interview from opening.
 */
export async function loadInterviewLanguage(): Promise<InterviewLanguage> {
  try {
    return parseStoredLanguage(await AsyncStorage.getItem(INTERVIEW_LANGUAGE_STORAGE_KEY));
  } catch {
    return DEFAULT_INTERVIEW_LANGUAGE;
  }
}

export async function saveInterviewLanguage(language: InterviewLanguage): Promise<void> {
  try {
    await AsyncStorage.setItem(INTERVIEW_LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Ignored — see above. The choice still applies to the running session.
  }
}
