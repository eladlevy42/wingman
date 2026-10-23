import type {
  Options,
  SDKUserMessage,
  SDKMessage,
  SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAuditContext, AgentCallOutcome, AgentPurpose } from "@wingman/shared";
import { recordAgentCall, resolveAuditContext } from "../services/agentCall.service";
import {
  classifyAssistantMessage,
  describeAgentError,
  isProcessLevelFailure,
  AgentAuthError,
  AgentSdkUnavailableError,
  type AgentQueryResult,
  type AgentTextBlock,
  type AgentToolUseBlock,
} from "./agentSdkClient";

// A warm, reusable Claude Agent SDK session. Each `runAgentQuery` (agentSdkClient)
// spawns a fresh Claude Code subprocess — a large fixed cost (~9-13s locally on
// Windows) paid on every call. This wraps the SDK's streaming-input mode
// (`prompt: AsyncIterable<SDKUserMessage>`) so ONE subprocess stays alive and
// serves many turns: the spawn is paid once, then each subsequent turn is ~1s.
// See issue #246. This is the warm counterpart to agentSdkClient's stateless
// runAgentQuery; unlike that call, the model here accumulates conversation
// history across turns (a deliberate change to the stateless soft-turn design of
// docs/adr/0004 — the caller opts in by using a session).
//
// Turns are serialized (one in flight at a time); interview usage is naturally
// sequential per session, so this is sufficient. The subprocess is spawned lazily
// on the first run(), so constructing a session is side-effect-free (and keeps
// unit tests that never run a turn from spawning anything).

// The subset of the SDK's `query` return we depend on: an async-iterable message
// stream with an optional close(). Kept minimal so tests can inject a fake.
export interface AgentQueryStream extends AsyncIterable<SDKMessage> {
  close?: () => void;
}
export type QueryFn = (args: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AgentQueryStream;

export interface AgentSessionConfig {
  // Prefixes error logs, e.g. "softTurn".
  logLabel: string;
  systemPrompt: string;
  model: string;
  maxTurns?: number;
  // Injectable for tests — defaults to the real SDK query.
  queryImpl?: QueryFn;
  // One AgentCall row per turn, exactly as the stateless runAgentQuery records
  // its calls (docs/adr/0038, #553). Required for the same reason it is
  // required there: this is the app's OTHER route to the Anthropic API, and a
  // warm interview session is the highest-volume agent spend in production —
  // leaving it silent would make the recorded total wrong rather than partial.
  audit: AgentAuditContext;
}

export interface AgentSession {
  // Sends one user prompt and resolves with that turn's final assistant text +
  // tool uses. Serialized against other run() calls on the same session.
  // `purposeOverride` re-labels the AgentCall row this turn writes — used by
  // prewarm() so its throwaway spend is separable from real turns.
  run(prompt: string, purposeOverride?: AgentPurpose): Promise<AgentQueryResult>;
  // Eagerly spawns the underlying subprocess so the ~15s spawn cost is paid
  // ahead of the first run() rather than on it. Pushes NO user message, so it
  // costs zero model tokens (see #249). Fire-and-forget, best-effort, and
  // idempotent — a spawn failure here never surfaces; the first real run()
  // falls back to a cold spawn exactly as without prewarm.
  prewarm(): void;
  // Ends the session and tears down the underlying subprocess. Idempotent.
  close(): void;
}

type AgentContentBlock = AgentTextBlock | AgentToolUseBlock | { type: string };

// The throwaway prompt prewarm() sends purely to pay the subprocess spawn+init.
// Kept minimal to keep the warm-up's token cost near zero (the fixed spawn
// dwarfs it anyway); the model's reply is always discarded.
const WARMUP_PROMPT = "Warm-up ping — reply with the single word: ready.";

// A hand-fed async message queue: the caller pushes user messages over time and
// the SDK pulls them, keeping the one subprocess alive between turns.
class UserMessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffer: SDKUserMessage[] = [];
  private readonly waiters: ((result: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(text: string): void {
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.buffer.push(message);
  }

  close(): void {
    this.closed = true;
    const waiter = this.waiters.shift();
    // The `done` sentinel value is never read by the consumer.
    if (waiter) waiter({ value: undefined as unknown as SDKUserMessage, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<SDKUserMessage>>((resolve) =>
        this.waiters.push(resolve)
      );
      if (next.done) return;
      yield next.value;
    }
  }
}

class AgentSessionImpl implements AgentSession {
  private readonly queue = new UserMessageQueue();
  private iterator: AsyncIterator<SDKMessage> | null = null;
  private stream: AgentQueryStream | null = null;
  // Serializes turns: each run() awaits the previous one before touching the
  // shared message stream, so a turn's messages are never interleaved.
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  // Guards prewarm() so the eager spawn is kicked off at most once.
  private prewarmed = false;

  constructor(private readonly config: AgentSessionConfig) {}

  // Spawns the subprocess on first use and reuses it thereafter.
  private ensureStarted(): AsyncIterator<SDKMessage> {
    if (this.iterator) return this.iterator;
    const queryImpl =
      this.config.queryImpl ??
      // The real SDK `query` returns a richer `Query` type that structurally
      // satisfies AgentQueryStream (async-iterable + close). // explanation:
      // the SDK's overloaded signature does not line up nominally with QueryFn.
      (query as unknown as QueryFn);
    const options: Options = {
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
      tools: [],
      // See agentSdkClient's runOnce for why this is "dontAsk", not
      // "bypassPermissions" (issue #410 — the latter is unconditionally refused
      // by the `claude` CLI when the host process runs as root/sudo).
      permissionMode: "dontAsk",
      maxTurns: this.config.maxTurns ?? 1,
    };
    this.stream = queryImpl({ prompt: this.queue, options });
    this.iterator = this.stream[Symbol.asyncIterator]();
    return this.iterator;
  }

  async run(prompt: string, purposeOverride?: AgentPurpose): Promise<AgentQueryResult> {
    if (this.closed) throw new Error(`${this.config.logLabel}: agent session is closed`);
    // Resolved per turn, not per session, so each turn joins the AuditEvent for
    // the user action that triggered it — and BEFORE the serialization slot is
    // taken below, because this throws on a bad audit context: a throw between
    // claiming `tail` and the try/finally that releases it would leave every
    // later turn on this session waiting on a promise nothing resolves.
    // Reading the correlationId here also means it is the caller's request,
    // not whichever request happens to be running when the queue drains.
    const context = resolveAuditContext(this.config.logLabel, {
      ...this.config.audit,
      ...(purposeOverride ? { purpose: purposeOverride } : {}),
    });
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    const record = (
      outcome: AgentCallOutcome,
      result: AgentQueryResult | null,
      error: unknown
    ): void => {
      // Fire-and-forget, same as runAgentQuery: the turn is already paid for.
      void recordAgentCall({
        correlationId: context.correlationId,
        userId: context.userId,
        actor: context.actor,
        purpose: context.purpose,
        model: this.config.model,
        costUsd: result?.costUsd ?? 0,
        durationMs: result?.durationMs ?? 0,
        // Names only — never the tool inputs.
        toolNames: result?.toolUses.map((use) => use.name) ?? [],
        // The warm session has no retry loop of its own; a failed turn falls
        // back to a fresh stateless call, which records its own row.
        retryCount: 0,
        outcome,
        errorMessage: error === null ? null : describeAgentError(error),
      });
    };
    try {
      const iterator = this.ensureStarted();
      this.queue.push(prompt);
      const toolUses: AgentToolUseBlock[] = [];
      let text = "";
      // Drive the shared stream manually (not `for await`) so an early return
      // does not close the generator and kill the reusable subprocess.
      while (true) {
        let value: SDKMessage, done: boolean | undefined;
        try {
          ({ value, done } = await iterator.next());
        } catch (error) {
          // The SDK's process transport throws these directly (subprocess
          // never started or died mid-session) rather than as a stream
          // message, so they bypass classifyAssistantMessage entirely — same
          // failure mode as agentSdkClient's runOnce. See issue #410.
          if (isProcessLevelFailure(error)) {
            const unavailable = new AgentSdkUnavailableError(
              `${this.config.logLabel}: Claude Agent SDK subprocess unavailable — ${(error as Error).message}`,
              { cause: error }
            );
            record("sdk_unavailable", null, unavailable);
            throw unavailable;
          }
          record("failed", null, error);
          throw error;
        }
        if (done) {
          const ended = new Error(`${this.config.logLabel}: agent session ended unexpectedly`);
          record("failed", null, ended);
          throw ended;
        }
        const message = value;
        if (message.type === "assistant") {
          try {
            classifyAssistantMessage(message as SDKAssistantMessage);
          } catch (error) {
            await this.drainCurrentTurn(iterator);
            record(error instanceof AgentAuthError ? "auth_error" : "failed", null, error);
            throw error;
          }
          const blocks = (message as SDKAssistantMessage).message
            .content as unknown as AgentContentBlock[];
          const textBlocks = blocks.filter((b): b is AgentTextBlock => b.type === "text");
          if (textBlocks.length > 0) text = textBlocks.map((b) => b.text).join("\n");
          for (const block of blocks) {
            if (block.type === "tool_use") toolUses.push(block as AgentToolUseBlock);
          }
        }
        if (message.type === "result") {
          if (message.is_error) {
            const failed: Error & { auditCode?: string } = new Error(
              `${this.config.logLabel}: agent query failed — ${message.subtype}`
            );
            failed.auditCode = message.subtype;
            // The SDK reported cost/duration on this message even though the
            // turn errored — real spend, so it is recorded rather than zeroed.
            record(
              "failed",
              {
                text: "",
                thinking: "",
                toolUses,
                costUsd: message.total_cost_usd,
                durationMs: message.duration_ms,
              },
              failed
            );
            throw failed;
          }
          const result: AgentQueryResult = {
            text,
            // This session-based path doesn't support captureThinking (issue
            // #420 only wires it into the stateless runOnce path).
            thinking: "",
            toolUses,
            costUsd: message.total_cost_usd,
            durationMs: message.duration_ms,
          };
          record("ok", result, null);
          return result;
        }
      }
    } finally {
      release();
    }
  }

  prewarm(): void {
    if (this.closed || this.prewarmed) return;
    this.prewarmed = true;
    // Drive a throwaway turn now to pay the ~15s subprocess spawn+init ahead of
    // the first real turn, so it overlaps the seconds the user spends on the
    // instant fact questions (#249). A tiny warm-up CALL is required — not just
    // invoking query(): the SDK emits nothing until it receives input (verified:
    // pulling the stream with no input pushed blocks indefinitely), and it only
    // drives the subprocess boot to completion as that first turn is processed.
    // So there is no way to warm the subprocess without one model call. This is
    // the deliberate, documented tradeoff #249's AC permits ("no throwaway model
    // call ... or the tradeoff is documented"): one cheap warm-up turn per
    // interview (dominated by the fixed spawn, negligible token cost), whose
    // reply is discarded and whose only lasting effect is one extra entry in the
    // warm session's accumulated history.
    //
    // Routed through run() so it shares the same tail serialization: the first
    // real run() queues behind this warm-up and never interleaves with it. The
    // user cannot reach the first soft node before finishing the fact questions,
    // so that wait is hidden. Best-effort: a warm-up failure is swallowed — the
    // first real run() then simply pays the spawn itself, exactly as without
    // prewarm (an auth failure there surfaces normally).
    void this.run(WARMUP_PROMPT, "session_prewarm").catch(() => {
      // Intentionally ignored — see above. A cold first turn is the fallback.
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.close();
    try {
      this.stream?.close?.();
    } catch {
      // Best-effort teardown — the subprocess may already be gone.
    }
  }

  // After a mid-turn failure (e.g. classifyAssistantMessage throwing on an
  // assistant-level error), the shared stream still owes this turn its
  // terminal `result` message. If we don't read it here, the next run() call
  // reads it instead and misattributes it to the new turn, desyncing turn
  // framing for the rest of the session. Drain until that `result` (or the
  // stream ends) before propagating the original error.
  private async drainCurrentTurn(iterator: AsyncIterator<SDKMessage>): Promise<void> {
    while (true) {
      const { value, done } = await iterator.next();
      if (done || value.type === "result") return;
    }
  }
}

export function createAgentSession(config: AgentSessionConfig): AgentSession {
  return new AgentSessionImpl(config);
}
