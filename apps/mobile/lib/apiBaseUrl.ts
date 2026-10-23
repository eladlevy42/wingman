import Constants from "expo-constants";

// The api listens here (apps/api). The web client never needs the port because
// Vite proxies /api on the dev server's own origin; a phone has no such proxy,
// so it must address the dev machine directly.
export const API_PORT = 3001;

// Derives the absolute api origin the device should call.
//
// In Expo Go the bundle is served from the dev machine's LAN address, which the
// runtime reports as `hostUri` ("192.168.1.42:8081"). The api runs on that same
// machine, so swapping the Metro port for the api port gives the right origin
// without anyone hand-editing an IP when the network changes.
//
// EXPO_PUBLIC_API_URL overrides everything, for the cases the heuristic cannot
// cover: a tunnelled session (where hostUri is an *.exp.direct host that does
// not serve the api), a physical device pointed at a staging api, or an
// emulator that needs a loopback alias.
//
// Exported as a pure function of its inputs so it is testable without a running
// Expo runtime; `apiBaseUrl()` below is the thin runtime wrapper.
export function resolveApiBaseUrl(input: {
  explicitUrl?: string | null;
  hostUri?: string | null;
}): string {
  const explicit = input.explicitUrl?.trim();
  if (explicit) return stripTrailingSlash(explicit);

  const hostUri = input.hostUri?.trim();
  if (!hostUri) {
    throw new Error(
      "Cannot determine the API URL: Expo reported no hostUri. Set EXPO_PUBLIC_API_URL to the api origin (e.g. http://192.168.1.42:3001)."
    );
  }

  // hostUri is "host:port" or occasionally a full URL; take the host only.
  const withoutScheme = hostUri.replace(/^[a-z]+:\/\//i, "");
  const host = withoutScheme.split("/")[0].split(":")[0];
  return `http://${host}:${API_PORT}`;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

// Memoised because every request calls it and the answer cannot change within
// a session — hostUri is fixed once the bundle has loaded.
let cached: string | null = null;

export function apiBaseUrl(): string {
  if (cached === null) {
    cached = resolveApiBaseUrl({
      explicitUrl: process.env.EXPO_PUBLIC_API_URL,
      hostUri: Constants.expoConfig?.hostUri ?? null,
    });
  }
  return cached;
}
