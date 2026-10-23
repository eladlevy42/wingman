import { useEffect, useState } from "react";
import { addressFormForGender, type AddressForm } from "@wingman/shared";
import { loadUser } from "~/lib/session";

/**
 * How the chat's own Hebrew copy addresses the signed-in user (אתה/את/אתם),
 * from the gender stored with their session at sign-in. The api derives
 * Barney's lines from the same registered gender, so the two always agree.
 *
 * Starts at the neutral plural and settles once storage has been read.
 * AsyncStorage has no synchronous read, so a gendered user can briefly see the
 * plural composer placeholder before it switches — a one-render flash, not a
 * wrong render.
 */
export function useAddressForm(): AddressForm {
  const [address, setAddress] = useState<AddressForm>("plural");

  useEffect(() => {
    let cancelled = false;
    void loadUser().then((user) => {
      if (!cancelled) setAddress(addressFormForGender(user?.gender));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return address;
}
