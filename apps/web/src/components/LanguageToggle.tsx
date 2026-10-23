import {
  CHAT_UI_STRINGS,
  INTERVIEW_LANGUAGE_OPTIONS,
  type InterviewLanguage,
} from "@wingman/shared";
import { cn } from "@/lib/utils";

interface LanguageToggleProps {
  language: InterviewLanguage;
  onChange: (language: InterviewLanguage) => void;
  disabled?: boolean;
}

/**
 * The EN/HE flag switch shown in the interview header (ADR-0037).
 *
 * Two flag buttons rather than a dropdown: there are exactly two languages, and
 * the whole point is that a Hebrew speaker who lands on an English interview
 * can fix it in one tap without reading anything. It reuses the chip vocabulary
 * the answer options already use, so it reads as part of the same surface
 * rather than as browser chrome.
 */
export default function LanguageToggle({ language, onChange, disabled }: LanguageToggleProps) {
  return (
    <div
      role="group"
      aria-label={CHAT_UI_STRINGS[language].languageToggleAccessibility}
      className="flex items-center gap-1"
    >
      {INTERVIEW_LANGUAGE_OPTIONS.map((option) => {
        const isActive = option.language === language;
        return (
          <button
            key={option.language}
            type="button"
            data-testid={`language-${option.language}`}
            onClick={() => onChange(option.language)}
            disabled={disabled}
            aria-pressed={isActive}
            aria-label={option.label}
            title={option.label}
            className={cn(
              "rounded-full border px-2 py-0.5 text-sm leading-none transition-colors duration-200 disabled:pointer-events-none disabled:opacity-40",
              isActive
                ? "border-brand bg-brand/20"
                : "border-transparent opacity-50 hover:opacity-100"
            )}
          >
            {option.flag}
          </button>
        );
      })}
    </div>
  );
}
