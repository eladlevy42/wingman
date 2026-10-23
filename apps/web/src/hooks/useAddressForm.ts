import { useState } from "react";
import { addressFormForGender, UserResponseSchema, type AddressForm } from "@wingman/shared";

/**
 * Parses the stored session value into an address form, or the neutral plural
 * for anything missing, corrupt, or no longer matching the shared schema.
 * Pure and exported so the parsing rule is testable without touching
 * localStorage or rendering a component.
 */
export function addressFormFromStoredUser(raw: string | null): AddressForm {
  if (raw === null) return "plural";
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "plural";
  }
  const parsed = UserResponseSchema.safeParse(value);
  return parsed.success ? addressFormForGender(parsed.data.gender) : "plural";
}

/**
 * How the chat's own Hebrew copy addresses the signed-in user (אתה/את/אתם),
 * from the gender stored with their session at sign-in. The api derives
 * Barney's lines from the same registered gender, so the two always agree.
 *
 * Read synchronously on first render (lazy `useState` initializer, same idiom
 * as `useInterviewLanguage`): localStorage, unlike mobile's AsyncStorage, is
 * available immediately, so there is no plural-then-gendered flash the way
 * there is on mobile, and the value never needs recomputing on later renders.
 *
 * Wrapped in try/catch: localStorage throws outright in a private-mode Safari
 * window and in some embedded webviews, and an address form is never worth
 * taking the interview down for.
 */
export function useAddressForm(): AddressForm {
  const [address] = useState<AddressForm>(() => {
    try {
      return addressFormFromStoredUser(window.localStorage.getItem("user"));
    } catch {
      return "plural";
    }
  });
  return address;
}
