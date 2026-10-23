import { describe, expect, it } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { correlationId, currentCorrelationId, runWithCorrelationId } from "./correlationId";

// Runs the middleware over a stub request and resolves with whatever the
// handler chain (next) produced — the shape express gives it, minus express.
function runRequest<T>(handler: () => Promise<T>): Promise<{ reqId: string; result: T }> {
  return new Promise((resolve, reject) => {
    const req = {} as Request & { correlationId?: string };
    const next: NextFunction = () => {
      handler()
        .then((result) => resolve({ reqId: req.correlationId!, result }))
        .catch(reject);
    };
    correlationId(req, {} as Response, next);
  });
}

describe("correlationId middleware", () => {
  it("assigns one id per request and exposes it on the request", async () => {
    const { reqId } = await runRequest(async () => null);
    expect(reqId).toBeTruthy();
  });

  it("makes the same id visible to everything the request runs, across awaits", async () => {
    const { reqId, result } = await runRequest(async () => {
      const before = currentCorrelationId();
      // An await boundary — the AsyncLocalStorage context must survive it,
      // since real writers sit several awaited calls below the route.
      await Promise.resolve();
      const after = currentCorrelationId();
      return { before, after };
    });

    expect(result.before).toBe(reqId);
    expect(result.after).toBe(reqId);
  });

  it("gives two requests two different ids", async () => {
    const first = await runRequest(async () => currentCorrelationId());
    const second = await runRequest(async () => currentCorrelationId());
    expect(first.reqId).not.toBe(second.reqId);
  });
});

describe("runWithCorrelationId", () => {
  it("scopes an explicit id over non-request work", async () => {
    const seen = await runWithCorrelationId(async () => {
      await Promise.resolve();
      return currentCorrelationId();
    }, "sweep-tick-1");
    expect(seen).toBe("sweep-tick-1");
  });

  it("reads undefined outside any scope", () => {
    expect(currentCorrelationId()).toBeUndefined();
  });
});
