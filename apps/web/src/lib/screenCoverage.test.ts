import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { screenForPath } from "@wingman/shared";

// The web counterpart of apps/mobile/lib/screenCoverage.test.ts (#554): a route
// added to App.tsx without a screen name emits views that all land on
// "unknown", which reads as a drop-off rather than as a missing mapping.

const APP_TSX = readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");

// Dev-only routes are excluded deliberately: /dev/match-pipeline and the chat
// harness are not part of anyone's funnel, and naming them would put internal
// tooling into the product's screen vocabulary.
const routes = Array.from(APP_TSX.matchAll(/path="([^"]+)"/g))
  .map((match) => match[1]!)
  .filter((route) => route !== "*" && !route.startsWith("/dev/"));

describe("every web route has a screen name", () => {
  it("found the app's routes", () => {
    expect(routes.length).toBeGreaterThan(5);
    expect(routes).toContain("/register");
    expect(routes).toContain("/");
  });

  it.each(routes)("maps %s to a named screen", (route) => {
    expect(screenForPath(route)).not.toBe("unknown");
  });
});
