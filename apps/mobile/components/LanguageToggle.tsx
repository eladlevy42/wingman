import { Pressable, View } from "react-native";
import {
  CHAT_UI_STRINGS,
  INTERVIEW_LANGUAGE_OPTIONS,
  type InterviewLanguage,
} from "@wingman/shared";
import { Text } from "~/components/ui/text";
import { cn } from "~/lib/utils";

interface LanguageToggleProps {
  language: InterviewLanguage;
  onChange: (language: InterviewLanguage) => void;
  disabled?: boolean;
}

/**
 * The ENG/HEB switch in the interview header — the React Native counterpart
 * of apps/web/src/components/LanguageToggle.tsx (ADR-0037).
 *
 * Two buttons rather than a picker: there are exactly two languages, and a
 * Hebrew speaker who lands on an English interview should be able to fix it in
 * one tap. Text codes rather than flags: a flag ties the language to a country,
 * and the codes are easier to tell apart at a glance.
 */
export default function LanguageToggle({ language, onChange, disabled }: LanguageToggleProps) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={CHAT_UI_STRINGS[language].languageToggleAccessibility}
      className="flex-row items-center gap-1"
    >
      {INTERVIEW_LANGUAGE_OPTIONS.map((option) => {
        const isActive = option.language === language;
        return (
          <Pressable
            key={option.language}
            testID={`language-${option.language}`}
            onPress={() => onChange(option.language)}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ checked: isActive, disabled: Boolean(disabled) }}
            accessibilityLabel={option.label}
            className={cn(
              "rounded-full border px-2.5 py-1",
              isActive ? "border-brand bg-brand/20" : "border-transparent opacity-50",
              disabled && "opacity-40"
            )}
          >
            <Text
              className={cn(
                "text-[11px] font-bold leading-tight tracking-[1px]",
                isActive ? "text-brand" : "text-muted-foreground"
              )}
              // A language code is a Latin-script run; keep it LTR even when the
              // surrounding chat surface is RTL.
              style={{ writingDirection: "ltr" }}
            >
              {option.code}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
