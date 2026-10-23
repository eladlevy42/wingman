import { describe, it, expect, vi } from "vitest";
import type { Request, Response } from "express";
import { jsonBodyErrorHandler } from "./errorHandler";

function createBodyParserSyntaxError(): SyntaxError {
  const err = new SyntaxError("Unexpected token in JSON");
  return Object.assign(err, {
    status: 400,
    statusCode: 400,
    body: "{not valid json",
    type: "entity.parse.failed",
  });
}

function createMockResponse() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

describe("jsonBodyErrorHandler", () => {
  it("returns a JSON 400 error for a malformed-JSON body-parser SyntaxError", () => {
    const err = createBodyParserSyntaxError();
    const res = createMockResponse();
    const next = vi.fn();

    jsonBodyErrorHandler(err, {} as Request, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid JSON body" });
    expect(next).not.toHaveBeenCalled();
  });

  it("forwards unrelated errors to the next handler", () => {
    const err = new Error("something else");
    const res = createMockResponse();
    const next = vi.fn();

    jsonBodyErrorHandler(err, {} as Request, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(err);
  });

  it("forwards a plain SyntaxError without body-parser markers to the next handler", () => {
    const err = new SyntaxError("unrelated syntax error");
    const res = createMockResponse();
    const next = vi.fn();

    jsonBodyErrorHandler(err, {} as Request, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(err);
  });
});
