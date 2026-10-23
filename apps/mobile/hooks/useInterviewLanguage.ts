import { useCallback, useEffect, useState } from "react";
import { DEFAULT_INTERVIEW_LANGUAGE, type InterviewLanguage } from "@wingman/shared";
import { loadInterviewLanguage, saveInterviewLanguage } from "~/lib/interviewLanguage";

export interface UseInterviewLanguage {
  language: InterviewLanguage;
  setLanguage: (language: InterviewLanguage) => void;
  // False until the stored choice has been read. The interview must not open a
  // session before this is true, or a user whose saved choice is English would
  // have the whole conversation started in Hebrew and only switched afterwards.
  // AsyncStorage is async — unlike web's localStorage, there is no synchronous
  // first read to lean on.
  ready: boolean;
}

/** The interview language, restored from storage and saved on every change. */
export function useInterviewLanguage(): UseInterviewLanguage {
  const [language, setLanguageState] = useState<InterviewLanguage>(DEFAULT_INTERVIEW_LANGUAGE);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadInterviewLanguage().then((stored) => {
      if (cancelled) return;
      setLanguageState(stored);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setLanguage = useCallback((next: InterviewLanguage) => {
    setLanguageState(next);
    void saveInterviewLanguage(next);
  }, []);

  return { language, setLanguage, ready };
}
