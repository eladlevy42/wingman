import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { UserStateResponseSchema } from "@wingman/shared";
import ScreenFailure from "~/components/ScreenFailure";
import ScreenLoading from "~/components/ScreenLoading";
import { ApiError, apiRequest } from "~/lib/api";
import { ROUTES, routeForState } from "~/lib/routeForState";
import { clearUser, loadUser } from "~/lib/session";

/**
 * Boot screen. Decides where a launch lands: sign-in when there is no stored
 * session, otherwise whatever the api says this user's onboarding progress
 * calls for.
 *
 * This is why "an existing user lands in the correct state" holds on a cold
 * start and not just straight after a sign-in — the stored session is only an
 * id, and the server is always the authority on what comes next.
 */
export default function Boot() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  // Bumped by "Try again". The decision lives entirely inside the effect, so
  // re-running it is a matter of changing what the effect depends on.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const user = await loadUser();
      if (cancelled) return;
      if (!user) {
        router.replace(ROUTES.login);
        return;
      }

      try {
        const state = await apiRequest(`/api/users/${user.id}/state`, {
          schema: UserStateResponseSchema,
        });
        if (cancelled) return;
        router.replace(routeForState(state));
      } catch (err) {
        // Only a 404 means the stored session points at a user the api no longer
        // has (a reset dev database, most often) — that one is a permanent dead
        // end, and dropping the session turns it into a normal sign-in.
        //
        // Everything else is transient: the api is down, or the phone moved off
        // the network. Clearing the session there would sign someone out
        // mid-interview and, worse, leave "Try again" unable to do anything but
        // route to sign-in — the button would never be able to retry.
        if (err instanceof ApiError && err.status === 404) await clearUser();
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router, attempt]);

  if (failed) {
    return (
      <ScreenFailure
        title="Can't reach Wingman"
        body="The app couldn't load your session. Check that the api is running and that this device is on the same network, then try again."
        onRetry={() => {
          setFailed(false);
          setAttempt((n) => n + 1);
        }}
        // Sign-in, not sign-out: this screen is reached before we know who the
        // user is, and there may be no valid session to drop.
        escape={{ label: "Sign in instead", onPress: () => router.replace(ROUTES.login) }}
      />
    );
  }

  return <ScreenLoading />;
}
