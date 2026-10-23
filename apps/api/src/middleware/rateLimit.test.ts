import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { rateLimit, positiveIntFromEnv } from "./rateLimit";

function fakeRes(): Response & { statusCode?: number; body?: unknown } {
  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    headers: {} as Record<string, unknown>,
    setHeader(name: string, value: unknown) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode?: number; body?: unknown };
}

function reqFrom(ip: string): Request {
  return { ip } as Request;
}

describe("rateLimit", () => {
  it("allows requests up to the limit and rejects the next with 429", () => {
    const middleware = rateLimit({ limit: 2, windowMs: 1000, now: () => 0 });
    const next = vi.fn() as unknown as NextFunction;

    middleware(reqFrom("1.1.1.1"), fakeRes(), next);
    middleware(reqFrom("1.1.1.1"), fakeRes(), next);
    const blocked = fakeRes();
    middleware(reqFrom("1.1.1.1"), blocked, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toEqual({ error: "Too many requests" });
  });

  it("counts each client separately", () => {
    const middleware = rateLimit({ limit: 1, windowMs: 1000, now: () => 0 });
    const next = vi.fn() as unknown as NextFunction;

    middleware(reqFrom("1.1.1.1"), fakeRes(), next);
    middleware(reqFrom("2.2.2.2"), fakeRes(), next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it("lets a client through again once its window has passed", () => {
    let clock = 0;
    const middleware = rateLimit({ limit: 1, windowMs: 1000, now: () => clock });
    const next = vi.fn() as unknown as NextFunction;

    middleware(reqFrom("1.1.1.1"), fakeRes(), next);
    const blocked = fakeRes();
    middleware(reqFrom("1.1.1.1"), blocked, next);
    expect(blocked.statusCode).toBe(429);

    clock = 1000;
    middleware(reqFrom("1.1.1.1"), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("tells a blocked client when to come back", () => {
    const middleware = rateLimit({ limit: 1, windowMs: 5000, now: () => 0 });
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeRes();

    middleware(reqFrom("1.1.1.1"), fakeRes(), next);
    middleware(reqFrom("1.1.1.1"), res, next);

    expect((res as unknown as { headers: Record<string, unknown> }).headers["Retry-After"]).toBe(5);
  });
});

describe("positiveIntFromEnv", () => {
  const KEY = "TELEMETRY_TEST_VALUE";
  let consoleWarn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env[KEY];
    consoleWarn.mockRestore();
  });

  it("reads a valid value", () => {
    process.env[KEY] = "120";
    expect(positiveIntFromEnv(KEY, 60)).toBe(120);
  });

  it("falls back when unset or empty", () => {
    expect(positiveIntFromEnv(KEY, 60)).toBe(60);
    process.env[KEY] = "   ";
    expect(positiveIntFromEnv(KEY, 60)).toBe(60);
  });

  // The #381 precedent: a malformed env var falls back rather than throwing at
  // startup, so a typo cannot stop the API from booting.
  it.each(["abc", "-5", "0", "1.5"])("falls back rather than throwing on %s", (raw) => {
    process.env[KEY] = raw;
    expect(positiveIntFromEnv(KEY, 60)).toBe(60);
    expect(consoleWarn).toHaveBeenCalled();
  });
});
