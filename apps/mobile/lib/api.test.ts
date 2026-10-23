import { afterEach, describe, expect, it, vi } from "vitest";
import { BarneySessionResponseSchema } from "@wingman/shared";
import {
  ApiError,
  NetworkError,
  ResponseShapeError,
  apiRequest,
  apiRequestNoContent,
  extractErrorMessage,
} from "./api";

// A real schema from packages/shared rather than a throwaway one, so these
// tests exercise apiRequest exactly as the screens call it. zod itself is not a
// direct dependency of this app — it arrives through @wingman/shared.
const Schema = BarneySessionResponseSchema;
const SESSION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
    ...response,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractErrorMessage", () => {
  it("uses the api's message when it is a string", () => {
    expect(extractErrorMessage({ error: "Email already registered" })).toBe(
      "Email already registered"
    );
  });

  it("falls back when the body carries Zod issues rather than a message", () => {
    // A 400 returns an array here; rendering it directly is what produces
    // "[object Object]" on screen.
    expect(
      extractErrorMessage({ error: [{ path: ["email"], message: "Invalid" }] }, "Failed")
    ).toBe("Failed");
  });

  it("falls back for an empty message, a non-object body, and null", () => {
    expect(extractErrorMessage({ error: "   " }, "Failed")).toBe("Failed");
    expect(extractErrorMessage("nope", "Failed")).toBe("Failed");
    expect(extractErrorMessage(null, "Failed")).toBe("Failed");
  });
});

describe("apiRequest", () => {
  it("returns the parsed body on success", async () => {
    mockFetch({ json: async () => ({ sessionId: SESSION_ID, extra: "ignored" }) });
    await expect(apiRequest("/api/thing", { schema: Schema })).resolves.toEqual({
      sessionId: SESSION_ID,
    });
  });

  it("sends JSON with a content-type only when there is a body", async () => {
    const fetchMock = mockFetch({ json: async () => ({ sessionId: SESSION_ID }) });

    await apiRequest("/api/thing", { schema: Schema });
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();

    await apiRequest("/api/thing", { method: "POST", body: { a: 1 }, schema: Schema });
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
  });

  it("throws an ApiError carrying the status, so callers can branch on 404 vs 401", async () => {
    mockFetch({ ok: false, status: 404, json: async () => ({ error: "User not found" }) });

    const error = await apiRequest("/api/thing", { schema: Schema }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.message).toBe("User not found");
  });

  it("still produces a usable ApiError when the error body is not JSON", async () => {
    mockFetch({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    });

    const error = await apiRequest("/api/thing", { schema: Schema }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toMatch(/went wrong/i);
  });

  it("throws a NetworkError, naming the base url, when the request never lands", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network request failed")));

    const error = await apiRequest("/api/thing", { schema: Schema }).catch((e) => e);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.message).toContain("192.168.1.42:3001");
  });

  it("throws a ResponseShapeError when the body does not match the schema", async () => {
    mockFetch({ json: async () => ({ wrong: true }) });

    await expect(apiRequest("/api/thing", { schema: Schema })).rejects.toBeInstanceOf(
      ResponseShapeError
    );
  });
});

describe("apiRequestNoContent", () => {
  it("resolves on a 204 with no body", async () => {
    // The whole reason this variant exists: apiRequest would read the empty body
    // as JSON and turn a successful call into a ResponseShapeError.
    mockFetch({
      ok: true,
      status: 204,
      json: async () => {
        throw new Error("no body");
      },
    });

    await expect(
      apiRequestNoContent("/api/thing", { method: "POST", body: { a: 1 } })
    ).resolves.toBeUndefined();
  });

  it("still raises the same typed errors as apiRequest", async () => {
    mockFetch({ ok: false, status: 404, json: async () => ({ error: "User not found" }) });

    const error = await apiRequestNoContent("/api/thing", { method: "POST" }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.message).toBe("User not found");
  });
});
