import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import path from "node:path";
import { screenForPath } from "@wingman/shared";

// #554 requires a screen view on every route. The guard against that quietly
// becoming untrue is here rather than in a screen test: adding a file under
// `app/` adds a route, and if its path is not in the shared map the events it
// emits all land on "unknown" — which reads as a funnel drop rather than as a
// missing mapping. This test fails the moment a route is added without one.

const APP_DIR = path.resolve(__dirname, "../app");

// Not routes: the layout is a wrapper, and expo-router's special files start
// with "+" (e.g. +not-found).
function isRouteFile(name: string): boolean {
  return name.endsWith(".tsx") && !name.startsWith("+") && !name.startsWith("_");
}

function routePaths(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...routePaths(path.join(dir, entry.name), `${prefix}/${entry.name}`));
      continue;
    }
    if (!isRouteFile(entry.name)) continue;
    const base = entry.name.replace(/\.tsx$/, "");
    out.push(base === "index" ? prefix || "/" : `${prefix}/${base}`);
  }
  return out;
}

describe("every mobile route has a screen name", () => {
  const routes = routePaths(APP_DIR);

  it("found the app's routes", () => {
    expect(routes.length).toBeGreaterThan(5);
    expect(routes).toContain("/register");
    expect(routes).toContain("/barney/phase1");
  });

  it.each(routePaths(APP_DIR))("maps %s to a named screen", (route) => {
    expect(screenForPath(route)).not.toBe("unknown");
  });
});
