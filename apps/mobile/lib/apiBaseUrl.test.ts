import { describe, expect, it } from "vitest";
import { API_PORT, resolveApiBaseUrl } from "./apiBaseUrl";

describe("resolveApiBaseUrl", () => {
  it("derives the api origin from the Expo host, swapping the Metro port", () => {
    expect(resolveApiBaseUrl({ hostUri: "192.168.1.42:8081" })).toBe(
      `http://192.168.1.42:${API_PORT}`
    );
  });

  it("handles a hostUri that arrives as a full URL with a path", () => {
    expect(resolveApiBaseUrl({ hostUri: "http://192.168.1.42:8081/_expo" })).toBe(
      `http://192.168.1.42:${API_PORT}`
    );
  });

  it("prefers an explicit override over the derived host", () => {
    expect(
      resolveApiBaseUrl({
        explicitUrl: "https://staging.example.com",
        hostUri: "192.168.1.42:8081",
      })
    ).toBe("https://staging.example.com");
  });

  it("strips a trailing slash from the override so paths do not double up", () => {
    expect(resolveApiBaseUrl({ explicitUrl: "http://10.0.2.2:3001/" })).toBe(
      "http://10.0.2.2:3001"
    );
  });

  it("ignores a blank override rather than producing an empty base url", () => {
    expect(resolveApiBaseUrl({ explicitUrl: "   ", hostUri: "192.168.1.42:8081" })).toBe(
      `http://192.168.1.42:${API_PORT}`
    );
  });

  it("throws a directive error when there is nothing to derive from", () => {
    expect(() => resolveApiBaseUrl({ hostUri: null })).toThrow(/EXPO_PUBLIC_API_URL/);
  });
});
