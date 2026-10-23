import {
  query,
  type Options,
  type SDKAssistantMessage,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import {
  MAX_AGENT_ERROR_MESSAGE_LENGTH,
  type AgentAuditContext,
  type AgentCallOutcome,
} from "@wingman/shared";
import { recordAgentCall, resolveAuditContext } from "../services/agentCall.service";

// Bounded retry absorbs transient network blips (rate limits, overloaded,
// 5xx-equivalent) that a later attempt usually clears. Deterministic failures
// (bad auth, truncation, invalid request) are never retried — see docs/adr/0011.
// Backoff is exponential (BASE * 2^(n-1)): 1s, 2s, 4s, 8s, 16s across the five
// retries — up to ~31s of total wait. A 429 rate_limit (e.g. the Track 2 eval
// firing judge + 4 groundedness passes per couple concurrently, issue #420)
// routinely needs more than a couple of seconds to clear, so the earlier
// 3-attempt / 500ms schedule (max ~1.5s) exhausted and surfaced the error as a
// hard failure; this deeper schedule rides it out.
const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const AUTH_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed"]);
const TRANSIENT_ERRORS = new Set(["rate_limit", "overloaded", "server_error"]);

// Distinguishes an invalid/expired auth method from a transient failure —
// mirrors the raw SDK's Anthropic.AuthenticationError classification.
export class AgentAuthError extends Error {}
// Mirrors the raw SDK's "response truncated by max_tokens" handling.
export class AgentTruncatedError extends Error {}
// Internal-only: signals the retry loop in runAgentQuery to try again.
class TransientAgentError extends Error {}
// The Claude Code CLI subprocess itself never started or died mid-call — a
// distinct failure mode from an API-level error surfaced *through* a running
// subprocess (auth/transient/truncation above, all classified from a
// `message.error` field on a live session). This one is thrown directly by the
// SDK's process transport (see `isProcessLevelFailure` below) before any
// session ever exists, so it carries no `message.error` to classify. See
// issue #410: the CLI unconditionally refuses `--dangerously-skip-permissions`
// under root/sudo, which used to surface here as an opaque, uncaught 500
// indistinguishable from any other server error. Route handlers should catch
// this (and AgentAuthError) and respond with a clean, distinct error instead
// of a generic 500.
export class AgentSdkUnavailableError extends Error {
  // The original error thrown by the SDK's process transport. Kept as a plain
  // property (not `Error`'s ES2022 `cause` option) — this repo's `tsconfig`
  // targets ES2021, whose lib types don't include the two-arg Error
  // constructor overload.
  public readonly cause?: unknown;
  // See describeAgentError. The transport's own message names the executable
  // and the exit signal, which is exactly what the console log is for — the
  // audit row records only that the subprocess was the failure.
  public readonly auditCode = "process_level_failure";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "AgentSdkUnavailableError";
    this.cause = options?.cause;
  }
}

// An error raised by this module, tagged with the SDK's own code for it.
export interface CodedAgentError extends Error {
  auditCode?: string;
}

// Tags an error with the closed-vocabulary code it was raised from, so the
// AgentCall row can say WHY a call failed without carrying free text.
function coded<E extends Error>(error: E, auditCode: string): E {
  (error as CodedAgentError).auditCode = auditCode;
  return error;
}

/**
 * The content-free failure reason recorded on an AgentCall row (docs/adr/0038,
 * #553). Every error this module raises is tagged with a code drawn from the
 * SDK's own closed vocabulary — an assistant-level error code, a result
 * subtype — and only that code plus the error's class name is recorded.
 *
 * The error *message* is deliberately never used: it is free text, and free
 * text this close to a model is a content leak waiting to happen. The full
 * message still goes to the console, where it is a debugging aid rather than a
 * row in a queryable table with a 90-day life.
 */
export function describeAgentError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";
  const name = error.name || "Error";
  const code = (error as CodedAgentError).auditCode;
  return (code ? `${name}: ${code}` : name).slice(0, MAX_AGENT_ERROR_MESSAGE_LENGTH);
}

// Matches the plain-string errors the SDK's process transport throws when the
// `claude` CLI subprocess never starts or dies mid-call (e.g. "Claude Code
// process exited with code 1", "Claude Code process terminated by signal
// SIGKILL", "Failed to spawn Claude Code process: ENOENT", "Claude Code
// executable not found at ...", "Claude Code native binary ...") — see
// docs/adr/0011 Update (issue #410). The SDK does not export a dedicated error
// class for these, only ad hoc `Error` instances, so this is necessarily a
// message-shape match rather than an `instanceof` check. Deliberately excludes
// "aborted by user" — that is a deliberate cancellation, not an unavailability.
export function isProcessLevelFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /^(Claude Code (process (exited|terminated)|executable|native binary)|Failed to spawn Claude Code process)/.test(
    error.message
  );
}

export interface AgentTextBlock {
  type: "text";
  text: string;
}
export interface AgentToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface AgentThinkingBlock {
  type: "thinking";
  thinking: string;
}
type AgentContentBlock = AgentTextBlock | AgentToolUseBlock | AgentThinkingBlock | { type: string };

// Concatenate the turn's thinking-block text (adaptive extended thinking).
// Pure + exported so it can be unit-tested without an SDK round-trip.
export function extractThinking(blocks: { type: string }[]): string {
  return blocks
    .filter((b): b is AgentThinkingBlock => b.type === "thinking")
    .map((b) => b.thinking)
    .join("\n\n");
}

export interface AgentQueryParams {
  // Prefixes error logs, e.g. "BarneyAgent" / "NegotiationAgent" / "softTurn".
  logLabel: string;
  systemPrompt: string;
  // The Agent SDK has no structured message-history param like the raw
  // Messages API's `messages` array — each call is a single prompt string.
  // Callers replay the full transcript into this string. See docs/adr/0011.
  prompt: string;
  model: string;
  mcpServers?: Record<string, McpServerConfig>;
  allowedTools?: string[];
  maxTurns?: number;
  // Opt-in adaptive extended thinking (issue #420). Off by default.
  captureThinking?: boolean;
  // Who is calling and why, recorded as one AgentCall row per call
  // (docs/adr/0038, #553). Required, not optional: this function is the only
  // route to the Anthropic API (docs/adr/0011), so making the context
  // mandatory here is what guarantees no agent — including one added later —
  // can run unrecorded.
  audit: AgentAuditContext;
}

export interface AgentQueryResult {
  // The final assistant text of the turn (after any tool round-trips).
  text: string;
  // Every tool_use block seen across the turn, in call order.
  toolUses: AgentToolUseBlock[];
  // From the SDK's terminal "result" message — real Anthropic API cost/time
  // for this one call. 0 if the query errored before a result message arrived
  // (a retried attempt's cost is still real spend, but the SDK gives us no
  // partial-cost figure to attribute it to, so it's undercounted rather than
  // guessed). See issue #250 (eval cost/duration instrumentation).
  costUsd: number;
  durationMs: number;
  // Concatenated adaptive-thinking block text for the turn, when
  // captureThinking was requested. "" when not captured or none produced.
  thinking: string;
}

// One bounded, stateless agent call. Disables all built-in Claude Code tools
// (filesystem/bash) — callers opt specific custom tools in via mcpServers +
// allowedTools. See docs/adr/0011 for why this SDK is used statelessly
// instead of via its native session/resume machinery.
export async function runAgentQuery(params: AgentQueryParams): Promise<AgentQueryResult> {
  // Validated before the first attempt, so a call with no audit context fails
  // loudly instead of spending money on a row nothing can attribute. Throws
  // AgentAuditContextError — see services/agentCall.service.ts.
  const context = resolveAuditContext(params.logLabel, params.audit);

  // The row this call will be recorded under, written exactly once on the way
  // out of the function — whichever way it leaves. `attempt - 1` is the number
  // of retries already paid for when that happens.
  const record = (
    outcome: AgentCallOutcome,
    attempt: number,
    result: Pick<AgentQueryResult, "costUsd" | "durationMs" | "toolUses"> | null,
    error: unknown
  ): void => {
    // Fire-and-forget (docs/adr/0038): the agent call is already done and paid
    // for, so its result must not wait on — or be lost to — the audit write.
    void recordAgentCall({
      correlationId: context.correlationId,
      userId: context.userId,
      actor: context.actor,
      purpose: context.purpose,
      model: params.model,
      costUsd: result?.costUsd ?? 0,
      durationMs: result?.durationMs ?? 0,
      // Names only, never the tool inputs — those carry user content.
      toolNames: result?.toolUses.map((use) => use.name) ?? [],
      retryCount: attempt - 1,
      outcome,
      errorMessage: error === null ? null : describeAgentError(error),
    });
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await runOnce(params);
      record("ok", attempt, result, null);
      return result;
    } catch (error) {
      if (error instanceof AgentAuthError) {
        console.error(
          `${params.logLabel}: Claude Agent SDK authentication failure — check OAuth login or ANTHROPIC_API_KEY:`,
          error.message
        );
        record("auth_error", attempt, null, error);
        throw error;
      }
      if (error instanceof AgentSdkUnavailableError) {
        // Not retried: a dead/unspawnable subprocess is an environment problem
        // (missing `claude` CLI, broken auth, a hard CLI-level refusal like the
        // root/sudo case in issue #410) that a second attempt will not fix.
        console.error(
          `${params.logLabel}: Claude Agent SDK subprocess unavailable — the \`claude\` CLI failed to start or exited unexpectedly:`,
          error.message
        );
        record("sdk_unavailable", attempt, null, error);
        throw error;
      }
      if (attempt < MAX_ATTEMPTS && error instanceof TransientAgentError) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      // Retries exhausted, or a deterministic failure that was never retried.
      // Recorded either way: the attempts made were real spend, and losing
      // them silently is exactly what leaves production cost unmeasurable.
      record("failed", attempt, null, error);
      throw error;
    }
  }
  // Unreachable: the loop either returns a result, retries, or throws.
  throw new Error(`${params.logLabel}: no response from Claude Agent SDK`);
}

async function runOnce(params: AgentQueryParams): Promise<AgentQueryResult> {
  const options: Options = {
    model: params.model,
    systemPrompt: params.systemPrompt,
    tools: [],
    allowedTools: params.allowedTools,
    mcpServers: params.mcpServers,
    // "dontAsk" (not "bypassPermissions"): both suppress interactive prompts for
    // this non-interactive server process, but "bypassPermissions" additionally
    // requires the CLI's `--dangerously-skip-permissions` flag, which the
    // underlying `claude` CLI unconditionally refuses when the host process runs
    // as root/sudo ("cannot be used with root/sudo privileges for security
    // reasons") — true of many container/CI/dev-sandbox setups. That refusal
    // exits the subprocess with code 1 before it ever reaches the API, which
    // surfaced as issue #410. "dontAsk" denies only tool calls that are not
    // pre-approved; since `tools: []` disables all built-in tools and every
    // custom tool is explicitly opted in via `allowedTools` above, nothing here
    // is ever denied. See docs/adr/0011's Update (issue #410).
    permissionMode: "dontAsk",
    maxTurns: params.maxTurns ?? 10,
    // Adaptive extended thinking, opt-in per call (issue #420). Off by default
    // so production interview/negotiation behavior and cost are unchanged; the
    // eval path turns it on to log each agent's reasoning. 'adaptive' lets the
    // model decide depth; supported on Claude 4.6+ models incl. the eval's
    // default sonnet tier (claude-sonnet-4-6). display:"summarized" is explicit
    // so captured thinking has readable text on every thinking-capable model —
    // Opus 4.8 / Sonnet 5 default display to "omitted" (empty text) otherwise.
    ...(params.captureThinking
      ? { thinking: { type: "adaptive", display: "summarized" } as const }
      : {}),
  };

  const toolUses: AgentToolUseBlock[] = [];
  let text = "";
  let thinking = "";
  let costUsd = 0;
  let durationMs = 0;

  try {
    for await (const message of query({ prompt: params.prompt, options })) {
      if (message.type === "assistant") {
        classifyAssistantMessage(message);
        const blocks = message.message.content as unknown as AgentContentBlock[];
        const textBlocks = blocks.filter((block): block is AgentTextBlock => block.type === "text");
        if (textBlocks.length > 0) {
          text = textBlocks.map((block) => block.text).join("\n");
        }
        for (const block of blocks) {
          if (block.type === "tool_use") toolUses.push(block as AgentToolUseBlock);
        }
        if (params.captureThinking) {
          const turnThinking = extractThinking(blocks);
          if (turnThinking) thinking = thinking ? `${thinking}\n\n${turnThinking}` : turnThinking;
        }
      }
      if (message.type === "result") {
        costUsd = message.total_cost_usd;
        durationMs = message.duration_ms;
        if (message.is_error) {
          throw coded(
            new Error(`${params.logLabel}: agent query failed — ${message.subtype}`),
            message.subtype
          );
        }
      }
    }
  } catch (error) {
    // The SDK throws these directly from its process transport — before any
    // session/message ever exists — rather than surfacing them as a message on
    // the stream, so they bypass classifyAssistantMessage entirely. Re-thrown
    // as a distinct type so callers (and route handlers) never see this mixed
    // in with an ordinary Error. See issue #410.
    if (isProcessLevelFailure(error)) {
      throw new AgentSdkUnavailableError(
        `${params.logLabel}: Claude Agent SDK subprocess unavailable — ${(error as Error).message}`,
        { cause: error }
      );
    }
    throw error;
  }

  return { text, thinking, toolUses, costUsd, durationMs };
}

export function classifyAssistantMessage(message: SDKAssistantMessage): void {
  const error = message.error;
  if (!error) return;
  // `error` is the SDK's own error code — a closed vocabulary, which is why it
  // is safe to carry onto the audit row (see describeAgentError).
  if (AUTH_ERRORS.has(error)) throw coded(new AgentAuthError(error), error);
  if (error === "max_output_tokens") {
    throw coded(new AgentTruncatedError("response truncated by max_tokens limit"), error);
  }
  if (TRANSIENT_ERRORS.has(error)) throw coded(new TransientAgentError(error), error);
  throw coded(new Error(`Claude Agent SDK error: ${error}`), error);
}
