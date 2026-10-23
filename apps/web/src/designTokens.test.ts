import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Pins the product, mobile, and eval-dashboard palettes to each other so a
// token edit in one surface cannot drift from the others unnoticed.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

const WEB_CSS = "apps/web/src/index.css";
const MOBILE_CSS = "apps/mobile/global.css";
const MOBILE_COLORS = "apps/mobile/lib/colors.ts";
const EVAL_CSS = "apps/eval-dashboard/src/index.css";

/** Tokens that exist on web but have no React Native equivalent yet. */
const WEB_ONLY_TOKENS = new Set(["--popover", "--popover-foreground"]);

/** `--background: 0 0% 100%;` → `{ "--background": "0 0% 100%" }` */
function parseTokens(css: string): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [, name, value] of css.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)) {
    tokens.set(name, value.trim());
  }
  return tokens;
}

/** `hsl(0, 0%, 100%)` → `0 0% 100%`, the shape CSS variables are stored in. */
function hslCallToTokenValue(hslCall: string): string {
  const inner = hslCall.match(/^hsl\((.+)\)$/)?.[1];
  if (!inner) throw new Error(`Not an hsl() call: ${hslCall}`);
  return inner
    .split(",")
    .map((part) => part.trim())
    .join(" ");
}

function camelToKebabToken(name: string): string {
  return `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

const webTokens = parseTokens(read(WEB_CSS));

describe("web palette", () => {
  it("defines exactly one :root block and no dark palette", () => {
    const css = read(WEB_CSS);
    expect(css.match(/:root\s*\{/g)).toHaveLength(1);
    expect(css).not.toMatch(/\.dark\s*\{/);
  });

  it("is not the ShadCN default violet", () => {
    expect(webTokens.get("--primary")).not.toBe("263.4 70% 50.4%");
  });

  it("does not opt the document into dark mode", () => {
    expect(read("apps/web/index.html")).not.toMatch(/class="[^"]*\bdark\b/);
  });
});

describe("eval dashboard palette", () => {
  const evalTokens = parseTokens(read(EVAL_CSS));

  it("is genuinely a different palette from the product one", () => {
    expect(evalTokens.get("--background")).not.toBe(webTokens.get("--background"));
    expect(evalTokens.get("--primary")).not.toBe(webTokens.get("--primary"));
  });

  it("opts into dark mode explicitly, which the product clients must not", () => {
    expect(read("apps/eval-dashboard/index.html")).toMatch(/<html[^>]*class="[^"]*\bdark\b/);
  });
});

describe("apps/mobile mirrors of the web palette", () => {
  const mobileTokens = parseTokens(read(MOBILE_CSS));

  it("carries every web token except the deliberately web-only ones", () => {
    const expected = [...webTokens.keys()].filter((t) => !WEB_ONLY_TOKENS.has(t)).sort();
    expect([...mobileTokens.keys()].sort()).toEqual(expected);
  });

  it.each([...mobileTokens])("global.css %s matches index.css", (token, value) => {
    expect(webTokens.get(token)).toBe(value);
  });

  describe("lib/colors.ts", () => {
    const entries = [...read(MOBILE_COLORS).matchAll(/^\s*(\w+):\s*"(hsl\([^"]+\))"/gm)].map(
      ([, name, hsl]) => [name, hsl] as const
    );

    it("is not empty (the regex above still matches the file)", () => {
      expect(entries.length).toBeGreaterThan(0);
    });

    it.each(entries)("COLORS.%s resolves to the matching index.css token", (name, hsl) => {
      const token = camelToKebabToken(name);
      expect(webTokens.has(token)).toBe(true);
      expect(hslCallToTokenValue(hsl)).toBe(webTokens.get(token));
    });
  });
});
