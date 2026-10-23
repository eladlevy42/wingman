import { describe, expect, it } from "vitest";
import { cityToCoords, resolveCity, haversineDistanceKm } from "./geo";

describe("cityToCoords", () => {
  it("returns known coordinates for a listed city", () => {
    const result = cityToCoords("Tel Aviv");
    expect(result).toEqual({ lat: 32.0853, lng: 34.7818 });
  });

  it("is case-insensitive", () => {
    const result = cityToCoords("tel aviv");
    expect(result).toEqual({ lat: 32.0853, lng: 34.7818 });
  });

  it("resolves cities added to cover common Israeli entries (#331)", () => {
    // "Ramat Gan" and "Bat Yam" were the concrete examples in the bug report.
    expect(resolveCity("Ramat Gan").known).toBe(true);
    expect(resolveCity("Bat Yam").known).toBe(true);
  });

  it("falls back to Tel Aviv coordinates for an unknown city", () => {
    const result = cityToCoords("Nowhereville");
    expect(result).toEqual({ lat: 32.0853, lng: 34.7818 });
  });
});

describe("resolveCity", () => {
  it("marks a listed city as known", () => {
    expect(resolveCity("Jerusalem")).toEqual({ lat: 31.7683, lng: 35.2137, known: true });
  });

  it("marks an unlisted city as not known while still returning fallback coordinates (#331)", () => {
    const result = resolveCity("Nowhereville");
    expect(result.known).toBe(false);
    // Fallback coords are Tel Aviv's, but `known: false` lets callers avoid
    // treating this as a real location.
    expect(result).toEqual({ lat: 32.0853, lng: 34.7818, known: false });
  });
});

describe("haversineDistanceKm", () => {
  it("returns 0 for identical coordinates", () => {
    const point = { lat: 32.0853, lng: 34.7818 };
    expect(haversineDistanceKm(point, point)).toBe(0);
  });

  it("returns the known distance between Tel Aviv and Jerusalem (~54km)", () => {
    const telAviv = { lat: 32.0853, lng: 34.7818 };
    const jerusalem = { lat: 31.7683, lng: 35.2137 };
    const result = haversineDistanceKm(telAviv, jerusalem);
    expect(result).toBeGreaterThan(50);
    expect(result).toBeLessThan(58);
  });

  it("returns the known distance between Tel Aviv and New York (~9100km)", () => {
    const telAviv = { lat: 32.0853, lng: 34.7818 };
    const newYork = { lat: 40.7128, lng: -74.006 };
    const result = haversineDistanceKm(telAviv, newYork);
    expect(result).toBeGreaterThan(9000);
    expect(result).toBeLessThan(9300);
  });
});
