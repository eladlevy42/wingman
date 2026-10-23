import type { NextFunction, Request, Response } from "express";

// A fixed-window, in-memory rate limiter (#554). Hand-rolled rather than
// pulled from a package because CLAUDE.md §9 rules out Redis, which means an
// in-process counter is all any library would give us here anyway — and this
// is 40 lines with behaviour we can assert directly.
//
// The surface it guards is real: /api/telemetry takes whatever a client sends,
// and on a single-writer SQLite file an unbounded telemetry endpoint is a
// denial-of-service surface, not only a data-quality one (docs/adr/0038).

export interface RateLimitOptions {
  // Requests allowed per key per window.
  limit: number;
  windowMs: number;
  // Defaults to the request's IP. Injectable so a test does not need sockets.
  keyOf?: (req: Request) => string;
  // Injectable clock, so the window can be tested without waiting it out.
  now?: () => number;
}

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Reads a positive integer from the environment, falling back rather than
 * throwing on anything malformed — the DECISION_WINDOW_MINUTES precedent
 * (#381). A typo in an env var must not stop the API from booting.
 */
export function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      `${name}: expected a positive integer, got "${raw}" — falling back to ${fallback}`
    );
    return fallback;
  }
  return parsed;
}

export function rateLimit(options: RateLimitOptions) {
  const keyOf = options.keyOf ?? ((req: Request) => req.ip ?? "unknown");
  const now = options.now ?? (() => Date.now());
  const windows = new Map<string, Window>();

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const key = keyOf(req);
    const at = now();
    const current = windows.get(key);

    if (!current || at >= current.resetAt) {
      // Sweep expired windows on the way past, so an endpoint hit by many
      // one-off clients does not grow a map entry per client forever.
      for (const [otherKey, window] of Array.from(windows.entries())) {
        if (at >= window.resetAt) windows.delete(otherKey);
      }
      windows.set(key, { count: 1, resetAt: at + options.windowMs });
      next();
      return;
    }

    if (current.count >= options.limit) {
      res.setHeader("Retry-After", Math.ceil((current.resetAt - at) / 1000));
      res.status(429).json({ error: "Too many requests" });
      return;
    }

    current.count += 1;
    next();
  };
}
