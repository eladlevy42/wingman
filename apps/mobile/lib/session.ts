import AsyncStorage from "@react-native-async-storage/async-storage";
import { clearNotifications, UserResponseSchema, type UserResponse } from "@wingman/shared";
import { clearBarneySession } from "./barneySession";
import { setTelemetryUser } from "./telemetry";
import { registerForPushNotifications, unregisterPushNotifications } from "./push";

// Same key the web client writes to localStorage, so the stored shape stays one
// concept across both clients even though the storage backend differs.
export const SESSION_KEY = "user";

// Parses whatever was in storage back into a user, or null if it is missing,
// corrupt, or no longer matches the shared schema. Pure and exported so the
// "bad stored value logs you out rather than crashing you" behaviour is
// testable without a device.
export function parseStoredUser(raw: string | null): UserResponse | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = UserResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function saveUser(user: UserResponse): Promise<void> {
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(user));
  // Subsequent telemetry is attributed to this user (#554). Events already
  // queued keep the anonymous subject they were emitted under — signing in
  // does not backfill a userId onto the pre-auth events that led here, which
  // is the non-linkage docs/adr/0038 is built around. Hooked here for the same
  // reason push registration is: this is the one place every sign-in passes.
  setTelemetryUser(user.id);
  // Push registration is bound to the session rather than to the two screens
  // that sign someone in, for the same reason unregistration is below: this is
  // the one place every sign-in passes through. Hooking login.tsx and
  // register.tsx individually would leave a gap the day a third way in exists.
  //
  // Deliberately not awaited. Registration pops an OS permission dialog and
  // makes a round trip; awaiting it would hold the sign-in spinner on screen
  // underneath that dialog, and would fail a sign-in over a feature the app
  // works perfectly well without. registerForPushNotifications swallows its own
  // errors, so this cannot become an unhandled rejection.
  void registerForPushNotifications(user.id);
}

export async function loadUser(): Promise<UserResponse | null> {
  // A storage read can itself fail (a corrupt store on a device that ran out of
  // space). Treat that the same as "no session" — being sent to sign-in is
  // recoverable; a crash on launch is not.
  try {
    return parseStoredUser(await AsyncStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

export async function clearUser(): Promise<void> {
  // Read before the removal, because unregistering needs the id of the user
  // being signed out and there are four screens that sign out.
  //
  // Same hazard as the interview session below, one step worse: a device left
  // registered keeps receiving "You've got a match" for an account nobody on
  // this phone is signed into any more.
  const user = await loadUser();
  if (user) await unregisterPushNotifications(user.id);

  await AsyncStorage.removeItem(SESSION_KEY);
  // Back to the anonymous id — a sign-out, not a link back to anything (#554).
  setTelemetryUser(null);
  // A signed-out user's half-finished interview must not be offered back to
  // whoever signs in next on this device (#496).
  await clearBarneySession();
  // Same hazard, one slice later (#439): the notification store is a module
  // singleton and outlives the session, so without this the next person to sign
  // in on this handset opens the history panel and reads "You've got a match"
  // for someone else's match. The queue and badge go with it.
  clearNotifications();
}
