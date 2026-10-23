import type { z } from "zod";
import { apiBaseUrl } from "./apiBaseUrl";

// Thrown for any non-2xx api response. `status` is exposed because several
// screens branch on it the way the web pages do — a 404 from /auth/login means
// "no such account, send them to sign-up" rather than a generic failure.
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// Thrown when the request never reached the api (no route to host, api not
// running, phone on a different network). Separated from ApiError so the UI can
// say something useful instead of "500" — on a LAN-connected phone this is by
// far the most common failure, and the wording matters for anyone testing.
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

// Thrown when the api answered but its body did not match the shared schema.
// Kept distinct from ApiError so a contract drift is never mistaken for a
// server-side failure.
export class ResponseShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseShapeError";
  }
}

// Thrown when the server reported a failure mid-stream (an SSE `error` event)
// rather than through an HTTP status — by then the stream headers are already
// committed, so the reason can only arrive in-band. Same family as ApiError:
// the message came from the server and is safe to show.
export class ServerReportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerReportedError";
  }
}

// True for the errors whose message the server actually authored, and which are
// therefore worth showing verbatim instead of a generic apology. "AI service
// temporarily unavailable" tells someone what to do; "Something went wrong"
// costs them a debugging session.
export function isServerAuthoredError(err: unknown): err is Error {
  return (
    err instanceof ApiError || err instanceof NetworkError || err instanceof ServerReportedError
  );
}

const DEFAULT_ERROR_MESSAGE = "Something went wrong. Please try again.";

// Error bodies come in two shapes: `{ error: "message" }` for handled failures
// and `{ error: [...zod issues] }` for a 400. Only render the string form —
// otherwise the user sees "[object Object]", the bug the web pages guard
// against too.
export function extractErrorMessage(body: unknown, fallback = DEFAULT_ERROR_MESSAGE): string {
  if (typeof body !== "object" || body === null) return fallback;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" && error.trim() !== "" ? error : fallback;
}

interface SendOptions {
  // DELETE joins the union for push-token unregistration (#479), which is
  // the first endpoint here that removes something.
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  fallbackErrorMessage?: string;
}

interface RequestOptions<TSchema extends z.ZodTypeAny> extends SendOptions {
  // Every response is parsed with a schema from packages/shared (CLAUDE.md §6);
  // the schema is required rather than optional so a caller cannot quietly skip
  // validation.
  schema: TSchema;
}

// Sends the request and hands back the raw response, having already turned the
// two failure modes every caller treats the same way — an api that cannot be
// reached, and a non-2xx status — into typed errors. Split out so the
// no-content variant below shares exactly this behaviour instead of
// reimplementing it.
async function send(path: string, options: SendOptions): Promise<Response> {
  const url = `${apiBaseUrl()}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new NetworkError(
      `Could not reach the server at ${apiBaseUrl()}. Check that the api is running and that this device is on the same network.`
    );
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, extractErrorMessage(body, options.fallbackErrorMessage));
  }

  return response;
}

export async function apiRequest<TSchema extends z.ZodTypeAny>(
  path: string,
  options: RequestOptions<TSchema>
): Promise<z.infer<TSchema>> {
  const response = await send(path, options);

  const json = await response.json().catch(() => {
    throw new ResponseShapeError("The server returned a response that was not JSON.");
  });

  const parsed = options.schema.safeParse(json);
  if (!parsed.success) {
    throw new ResponseShapeError(`Unexpected response from ${path}.`);
  }
  return parsed.data;
}

// For endpoints that answer 204 No Content — today only
// POST /api/users/:id/photo. apiRequest cannot serve those: it always reads the
// body as JSON, so an empty one surfaces as a ResponseShapeError and a
// successful upload would look like contract drift. There is no response to
// validate here, hence no schema; the *request* is still schema-checked by the
// caller before it is sent (see lib/photo.ts).
export async function apiRequestNoContent(path: string, options: SendOptions): Promise<void> {
  await send(path, options);
}
