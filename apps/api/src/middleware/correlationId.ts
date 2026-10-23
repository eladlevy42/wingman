import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// One correlation id per request (docs/adr/0038, #552): the thread that links
// a user action's AuditEvent rows to every AgentCall the same request caused.
//
// Carried in AsyncLocalStorage rather than threaded through service
// signatures: the writers live several calls below the route handler, and the
// point of the id is that NOTHING between the boundary and the write has to
// know about it. Node keeps the store across awaits, so everything the request
// touches — however deep — reads the same id.
const correlationStorage = new AsyncLocalStorage<string>();

// The id of the request (or runWithCorrelationId scope) currently executing,
// or undefined outside any scope — e.g. a background sweep that has not opted
// in, where recordEvent falls back to a fresh id per event.
export function currentCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}

// For non-request work that wants its writes correlated — a sweep tick, a
// script. Everything `fn` does (including async continuations) shares `id`.
export function runWithCorrelationId<T>(fn: () => T, id: string = randomUUID()): T {
  return correlationStorage.run(id, fn);
}

// Express middleware: mint the id, expose it on the request for handlers that
// want to echo it, and run the rest of the chain inside its storage scope.
export function correlationId(req: Request, _res: Response, next: NextFunction): void {
  const id = randomUUID();
  (req as Request & { correlationId?: string }).correlationId = id;
  correlationStorage.run(id, next);
}
