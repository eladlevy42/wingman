import type { AddressForm, InputDescriptor, InterviewLanguage, Localized } from "@wingman/shared";

// The tree-authoring side of the interview's language layer (ADR-0037).
//
// The engine walks nodes whose copy exists in both Hebrew and English and emits
// one language per turn. Everything here is about *authoring* that copy; the
// language of the extracted values never changes (see softTurn.ts).

// The address form lives in @wingman/shared so the clients' own chat copy
// addresses the person exactly as the interview does. Re-exported here, where
// the interview code has always imported it from.
export { addressFormForGender, type AddressForm } from "@wingman/shared";

/**
 * One prompt line telling a model how to address the person in Hebrew, or null
 * when no instruction is needed (English replies, or no known gender). Shared
 * by every prompt that writes user-visible interview text (softTurn,
 * sideQuestion) so the voice cannot drift between them.
 */
export function addressInstruction(
  language: InterviewLanguage,
  address: AddressForm
): string | null {
  if (language !== "he" || address === "plural") return null;
  return address === "masculine" ? "Prompt redacted (masculine)." : "Prompt redacted (feminine).";
}

/**
 * One prompt line fixing how Barney spells his own name in Hebrew, or null for
 * English. Without it a model transliterating "Barney" is free to pick בארני,
 * which is not the name the app shows over his bubbles.
 */
export function nameInstruction(language: InterviewLanguage): string | null {
  return language === "he" ? "Prompt redacted." : null;
}

/**
 * A piece of interview copy.
 *
 * A `Localized<string>` is the normal case — one Hebrew string, one English
 * one. Hebrew conjugates by the addressee's gender, so a localized string may
 * also carry `heM`/`heF` variants; `he` stays the neutral-plural form and is
 * the fallback when a variant is missing. A bare `string` means "identical in
 * every language", which is what the engine's unit tests use for their
 * throwaway trees and what genuinely language-neutral copy (a bare number, a
 * proper noun) can use without pretending to be translated.
 */
export type Text = string | (Localized<string> & { heM?: string; heF?: string });

/** Resolves a Text for one language and Hebrew address form. */
export function t(
  value: Text,
  language: InterviewLanguage,
  address: AddressForm = "plural"
): string {
  if (typeof value === "string") return value;
  if (language === "he") {
    if (address === "masculine" && value.heM !== undefined) return value.heM;
    if (address === "feminine" && value.heF !== undefined) return value.heF;
    return value.he;
  }
  return value.en;
}

/** One selectable option, authored in both languages. */
export interface LocalizedChoice {
  label: Text;
  // The text the client actually sends back as the user's answer, so it must
  // read naturally in the interview's language — the extraction contract is
  // enforced by the soft-turn prompt, not by keeping this English (ADR-0037).
  value: Text;
}

/**
 * The authoring shape of an input control: structurally InputDescriptor, but
 * with Text wherever a user-visible string appears. `resolveInput` collapses it
 * to the wire-facing InputDescriptor for one language.
 */
export type LocalizedInput =
  | { kind: "text" }
  | { kind: "age"; min: number; max: number }
  | { kind: "height"; minCm: number; maxCm: number }
  | { kind: "choice"; options: readonly LocalizedChoice[]; allowFreeText: boolean }
  | {
      kind: "multiChoice";
      options: readonly LocalizedChoice[];
      allowFreeText: boolean;
      confirmLabel: Text;
    };

/** Collapses an authored input control to the descriptor sent to the client. */
export function resolveInput(
  input: LocalizedInput | undefined,
  language: InterviewLanguage,
  address: AddressForm = "plural"
): InputDescriptor {
  if (!input) return { kind: "text" };
  switch (input.kind) {
    case "choice":
      return {
        kind: "choice",
        allowFreeText: input.allowFreeText,
        options: input.options.map((o) => ({
          label: t(o.label, language, address),
          value: t(o.value, language, address),
        })),
      };
    case "multiChoice":
      return {
        kind: "multiChoice",
        allowFreeText: input.allowFreeText,
        confirmLabel: t(input.confirmLabel, language, address),
        options: input.options.map((o) => ({
          label: t(o.label, language, address),
          value: t(o.value, language, address),
        })),
      };
    default:
      return input;
  }
}
