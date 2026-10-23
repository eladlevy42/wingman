// Static POC lookup — no external geocoding service. Unknown cities fall back
// to Tel Aviv's coordinates rather than failing. See docs/adr/0006.
interface CityLocation {
  lat: number;
  lng: number;
  country: string;
}

const CITY_LOCATIONS: Record<string, CityLocation> = {
  "tel aviv": { lat: 32.0853, lng: 34.7818, country: "Israel" },
  jerusalem: { lat: 31.7683, lng: 35.2137, country: "Israel" },
  haifa: { lat: 32.794, lng: 34.9896, country: "Israel" },
  "beer sheva": { lat: 31.2518, lng: 34.7913, country: "Israel" },
  eilat: { lat: 29.5581, lng: 34.9482, country: "Israel" },
  netanya: { lat: 32.3215, lng: 34.8532, country: "Israel" },
  herzliya: { lat: 32.1663, lng: 34.8437, country: "Israel" },
  "rishon lezion": { lat: 31.9635, lng: 34.8018, country: "Israel" },
  ashdod: { lat: 31.8014, lng: 34.6435, country: "Israel" },
  "petah tikva": { lat: 32.0917, lng: 34.8872, country: "Israel" },
  "ramat gan": { lat: 32.07, lng: 34.8235, country: "Israel" },
  "bat yam": { lat: 32.0171, lng: 34.7457, country: "Israel" },
  holon: { lat: 32.0111, lng: 34.7792, country: "Israel" },
  "bnei brak": { lat: 32.0807, lng: 34.8338, country: "Israel" },
  givatayim: { lat: 32.0723, lng: 34.8125, country: "Israel" },
  rehovot: { lat: 31.8928, lng: 34.8113, country: "Israel" },
  "kfar saba": { lat: 32.175, lng: 34.9077, country: "Israel" },
  raanana: { lat: 32.1848, lng: 34.8713, country: "Israel" },
  "ramat hasharon": { lat: 32.1461, lng: 34.8394, country: "Israel" },
  "hod hasharon": { lat: 32.15, lng: 34.8892, country: "Israel" },
  modiin: { lat: 31.8969, lng: 35.0104, country: "Israel" },
  "nes ziona": { lat: 31.9293, lng: 34.7986, country: "Israel" },
  yavne: { lat: 31.8779, lng: 34.7397, country: "Israel" },
  ashkelon: { lat: 31.6688, lng: 34.5743, country: "Israel" },
  "kiryat gat": { lat: 31.61, lng: 34.7642, country: "Israel" },
  hadera: { lat: 32.4341, lng: 34.9196, country: "Israel" },
  nazareth: { lat: 32.7027, lng: 35.2971, country: "Israel" },
  tiberias: { lat: 32.7959, lng: 35.5308, country: "Israel" },
  nahariya: { lat: 33.0059, lng: 35.0949, country: "Israel" },
  acre: { lat: 32.9281, lng: 35.0818, country: "Israel" },
  safed: { lat: 32.9646, lng: 35.496, country: "Israel" },
  ramla: { lat: 31.9288, lng: 34.8667, country: "Israel" },
  lod: { lat: 31.9516, lng: 34.8953, country: "Israel" },
  dimona: { lat: 31.0707, lng: 35.0327, country: "Israel" },
  "kiryat shmona": { lat: 33.2075, lng: 35.5695, country: "Israel" },
};

const DEFAULT_LOCATION = CITY_LOCATIONS["tel aviv"];

function lookupCity(city: string): CityLocation | undefined {
  return CITY_LOCATIONS[city.trim().toLowerCase()];
}

// Resolve a city to coordinates, reporting whether the city was actually found
// (`known`) versus fell back to DEFAULT_LOCATION. Callers that must distinguish
// "we located this user" from "we have no idea" (the distance gate and ranking
// tie-break) rely on `known` so unknown cities don't masquerade as Tel Aviv and
// read as 0 km from everything. See #331.
export function resolveCity(city: string): { lat: number; lng: number; known: boolean } {
  const loc = lookupCity(city);
  if (loc) return { lat: loc.lat, lng: loc.lng, known: true };
  return { lat: DEFAULT_LOCATION.lat, lng: DEFAULT_LOCATION.lng, known: false };
}

export function cityToCoords(city: string): { lat: number; lng: number } {
  const { lat, lng } = resolveCity(city);
  return { lat, lng };
}

// The only country Wingman operates in. Registration is gated to Tel Aviv
// University addresses (ALLOWED_UNIVERSITY_DOMAINS), so every user and every
// seeded bot is Israeli. The interview no longer asks which country (#530) —
// it fills this instead, and the seed uses the same constant so a real profile
// and a bot can never disagree about it.
export const WINGMAN_COUNTRY = "Israel";

// Resolves a city to its country. No fallback — an unknown city means we
// genuinely don't know, and the caller decides what to do about it.
export function cityToCountry(city: string): string | null {
  return lookupCity(city)?.country ?? null;
}

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function haversineDistanceKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));

  return EARTH_RADIUS_KM * c;
}
