import type { InterviewLanguage } from "@wingman/shared";
import type { AddressForm } from "./localized";

// Barney's scripted lines. Wording is redacted in the public showcase version.
// The language and address-form split stays so the engine can still switch copy.

export interface EngineCopy {
  factAcks: readonly string[];
  skipAck: string;
  skipAckFinal: string;
  backAck: string;
  revisitAck: string;
  atFirstQuestion: string;
  addendumUpdated: string;
  addendumNoted: string;
  beforeLockIn: string;
  wrapupWithTopics: (topics: string) => string;
  wrapupPlain: string;
}

function copyFor(tag: string): EngineCopy {
  return {
    factAcks: [0, 1, 2, 3, 4, 5].map((i) => `[redacted:ack-${tag}-${i}]`),
    skipAck: `[redacted:skip-${tag}]`,
    skipAckFinal: `[redacted:skip-final-${tag}]`,
    backAck: `[redacted:back-${tag}]`,
    revisitAck: `[redacted:revisit-${tag}]`,
    atFirstQuestion: `[redacted:first-${tag}]`,
    addendumUpdated: `[redacted:addendum-updated-${tag}]`,
    addendumNoted: `[redacted:addendum-noted-${tag}]`,
    beforeLockIn: `[redacted:lock-${tag}]`,
    wrapupWithTopics: (topics) => `[redacted:wrapup-${tag}] ${topics}`,
    wrapupPlain: `[redacted:wrapup-plain-${tag}]`,
  };
}

const EN = copyFor("en");
const HE_PLURAL = copyFor("he");
const HE_MASCULINE = copyFor("he-m");
const HE_FEMININE = copyFor("he-f");

const HE_BY_ADDRESS: Record<AddressForm, EngineCopy> = {
  plural: HE_PLURAL,
  masculine: HE_MASCULINE,
  feminine: HE_FEMININE,
};

export function engineCopy(
  language: InterviewLanguage,
  address: AddressForm = "plural"
): EngineCopy {
  return language === "he" ? HE_BY_ADDRESS[address] : EN;
}
