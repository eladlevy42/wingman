import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { UserStateResponseSchema, type UserStateResponse } from "@wingman/shared";
import { apiRequest } from "~/lib/api";
import { guardOutcome, type Route } from "~/lib/routeForState";
import { loadUser } from "~/lib/session";

export interface GuardedRoute {
  /** The signed-in user's id, once the screen is cleared to render. */
  userId: string | null;
  /** False until the guard has decided; render a placeholder while it is. */
  ready: boolean;
  /**
   * The state the guard already fetched to make its decision, handed back so a
   * screen that needs a field from it does not pay for a second identical
   * request. The pitch needs `matchId` — there is still no other channel that
   * delivers it to a client (#53).
   *
   * A snapshot from mount, not a live read. Anything that has to notice the
   * user's state changing underneath it needs its own poll; see the note below
   * on why this guard is mount-time only.
   */
  state: UserStateResponse | null;
}

/**
 * Gate for a screen that only belongs to a user at a particular point in
 * onboarding, redirecting anyone else to where they actually belong.
 *
 * `expected` is the route `routeForState` returns for the state this screen is
 * for — so the server stays the single authority on onboarding order and this
 * hook never gets its own opinion about it. `/verified` passes `phase1`: it is
 * the interstitial in front of the interview, not a destination of its own.
 *
 * Before this, `verified.tsx` and `pending.tsx` never called `loadUser()` at
 * all and rendered in full to a visitor with no session — telling a signed-out
 * stranger "Your profile is saved", which is simply false. `phase1.tsx` did
 * check for a stored user, but only that *a* user existed: someone who had
 * already finished Phase 1 was handed a fresh interview from question one, and
 * finishing it overwrote their existing structuredData through saveProfile's
 * upsert, with no confirmation and no way back to the old version (#497).
 *
 * **Mount-time only.** The decision is made once, when the screen mounts, and
 * never re-checked — the name reads like a live guard, but nothing here watches
 * for the user's state changing underneath a screen that is already open. That
 * is correct for the three screens using it (each is a step the user passes
 * through, and the step that moves them on navigates away itself), and it is
 * what keeps the guard from issuing a request per render. A screen that stays
 * mounted across a state change needs something else, not a wider `expected`.
 *
 * **On an unreachable api this fails closed to the boot screen**, which makes
 * the same `/state` call. If that call succeeds there, boot routes back here
 * and this guard asks again — so an intermittent connection can bounce the user
 * between two loading screens with nothing saying why. Two round-trips per
 * bounce, so it is not a tight loop, and the alternative (letting the screen
 * through on a failed lookup) is what overwrote a finished profile in the first
 * place. Worth revisiting with a shared, cached state fetch rather than by
 * loosening the guard.
 */
export function useGuardedRoute(expected: Route): GuardedRoute {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [allowedState, setAllowedState] = useState<UserStateResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const user = await loadUser();
      if (cancelled) return;

      // null state means the lookup failed; guardOutcome decides what that is
      // worth. Only reached when there is a user to look up.
      let state = null;
      if (user) {
        try {
          state = await apiRequest(`/api/users/${user.id}/state`, {
            schema: UserStateResponseSchema,
          });
        } catch {
          state = null;
        }
      }
      if (cancelled) return;

      const outcome = guardOutcome(expected, user, state);
      if (!outcome.allowed) {
        router.replace(outcome.to);
        return;
      }
      setUserId(outcome.userId);
      // Non-null whenever the guard allowed the screen: guardOutcome only
      // returns allowed for a state it could actually read.
      setAllowedState(state);
      setReady(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [router, expected]);

  return { userId, ready, state: allowedState };
}
