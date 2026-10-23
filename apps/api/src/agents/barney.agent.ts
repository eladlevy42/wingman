import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { EventEmitter } from "node:events";
import { BarneyModeSchema } from "@wingman/shared";
import type { AgentPurpose, BarneyMode } from "@wingman/shared";
import { PROMPTS_BY_MODE } from "./prompts";
import { TOOL_FACTORIES_BY_MODE, type ToolCallEvent } from "./tools";
import { runAgentQuery } from "./agentSdkClient";
import { BARNEY_MODEL } from "./models";

// See docs/adr/0011 — migrated off the raw Messages API onto the Claude Agent
// SDK so dev/local runs can authenticate via a Claude Code OAuth login
// instead of requiring ANTHROPIC_API_KEY. Supersedes docs/adr/0003.
// Model id lives in models.ts (#303).

// Caps one sendMessage call's internal tool-use round-trips (the Agent SDK
// runs this loop itself — see runAgentQuery). Without a bound, a model that
// keeps invoking tools (a known LLM failure mode) would loop forever, making
// a paid API call every iteration.
export const MAX_TOOL_ITERATIONS = 10;

// What each mode's turns are recorded as on AgentCall (docs/adr/0038, #553).
// Both interviews share "interview_turn": which of the two it was is answered
// by the INTERVIEW_TURN AuditEvent sharing the same correlationId, so the
// purpose column stays about the kind of work rather than duplicating it.
const PURPOSE_BY_MODE: Record<BarneyMode, AgentPurpose> = {
  interview_self: "interview_turn",
  interview_wants: "interview_turn",
  pitch: "pitch_turn",
  debrief: "debrief_turn",
};

export type { ToolCallEvent };

interface BarneyAgentEvents {
  toolCall: [ToolCallEvent];
}

interface Turn {
  role: "user" | "assistant";
  text: string;
}

function formatTranscript(history: Turn[]): string {
  return history
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`)
    .join("\n\n");
}

// Holds one session's conversation in memory only — no database calls here.
// See docs/adr/0011 and CONTEXT.md "Session". Mode is fixed for the agent's
// lifetime; see CONTEXT.md "Mode switching".
export class BarneyAgent extends EventEmitter<BarneyAgentEvents> {
  private readonly systemPrompt: string;
  private readonly mode: BarneyMode;
  private readonly history: Turn[] = [];
  private busy = false;
  // Accumulated across every sendMessage call on this instance — read via
  // getUsage(). Eval-only concern (#250); production callers ignore it.
  private totalCostUsd = 0;
  private totalDurationMs = 0;

  constructor(
    mode: BarneyMode,
    private readonly userId: string,
    // Placeholder name (without braces) -> replacement text, e.g.
    // { RATIONALE_CONTEXT: match.rationale } fills PITCH_PROMPT's
    // {{RATIONALE_CONTEXT}} slot (docs/adr/0013, docs/adr/0014). Generic
    // rather than pitch-specific so debrief (#73) can reuse it.
    context?: Record<string, string>,
    // Only debrief sets this — it's the Match saveFeedback persists against
    // (docs/adr/0018, #75). Not a prompt placeholder, so it's separate from
    // `context` above; threaded into tool factories, not the system prompt.
    private readonly matchId?: string,
    // Overrides the production BARNEY_MODEL — only the eval dashboard
    // (#250) sets this, to run Track 3 extraction under a chosen model tier.
    private readonly modelOverride?: string
  ) {
    super();
    // Validate at construction rather than trusting the BarneyMode type alone
    // — the future API route (#19) passes through request input here, and an
    // unrecognized key would otherwise silently produce `undefined` lookups
    // below instead of a clear error.
    BarneyModeSchema.parse(mode);
    this.mode = mode;
    let systemPrompt = PROMPTS_BY_MODE[mode];
    if (context) {
      for (const [placeholder, value] of Object.entries(context)) {
        // Replacer function, not a plain string: a value containing a literal
        // `$` (e.g. a rationale mentioning money) would otherwise be misread
        // as a regex replacement pattern like $& or $$ (see negotiation.agent.ts).
        systemPrompt = systemPrompt.replaceAll(`{{${placeholder}}}`, () => value);
      }
    }
    this.systemPrompt = systemPrompt;
  }

  async sendMessage(text: string): Promise<string> {
    if (this.busy) {
      throw new Error("BarneyAgent: sendMessage is already in progress for this session");
    }
    this.busy = true;
    const historyLengthBeforeCall = this.history.length;

    try {
      this.history.push({ role: "user", text });

      const factories = TOOL_FACTORIES_BY_MODE[this.mode];
      const toolEvents: ToolCallEvent[] = [];
      // Rebuilt every turn (not cached at construction) so a tool that needs
      // the transcript — saveFeedback — always sees it up through the
      // current user message, not a stale snapshot from turn 1.
      const tools = factories.map((factory) =>
        factory(this.userId, (event) => toolEvents.push(event), {
          matchId: this.matchId,
          transcript: formatTranscript(this.history),
        })
      );
      const hasTools = tools.length > 0;
      const server = hasTools ? createSdkMcpServer({ name: "wingman", tools }) : undefined;

      const {
        text: reply,
        costUsd,
        durationMs,
      } = await runAgentQuery({
        logLabel: "BarneyAgent",
        systemPrompt: this.systemPrompt,
        prompt: formatTranscript(this.history),
        model: this.modelOverride ?? BARNEY_MODEL,
        mcpServers: server ? { wingman: server } : undefined,
        allowedTools: hasTools ? tools.map((t) => `mcp__wingman__${t.name}`) : undefined,
        maxTurns: MAX_TOOL_ITERATIONS,
        audit: {
          actor: "barney",
          purpose: PURPOSE_BY_MODE[this.mode],
          userId: this.userId,
        },
      });
      this.totalCostUsd += costUsd;
      this.totalDurationMs += durationMs;

      for (const event of toolEvents) this.emit("toolCall", event);

      if (!reply.trim()) {
        throw new Error("BarneyAgent: exceeded max tool-use iterations without a final reply");
      }

      this.history.push({ role: "assistant", text: reply });
      return reply;
    } catch (error) {
      // Roll back this turn's additions so history is left in a valid state
      // for the next sendMessage call — otherwise a failure mid-turn (API
      // error, runaway loop) leaves an orphaned entry that would corrupt
      // every subsequent call on this session.
      this.history.length = historyLengthBeforeCall;
      throw error;
    } finally {
      this.busy = false;
    }
  }

  // Real Anthropic API cost/time spent across every sendMessage call so far
  // on this instance. Eval-only (#250) — production callers never read this.
  getUsage(): { costUsd: number; durationMs: number } {
    return { costUsd: this.totalCostUsd, durationMs: this.totalDurationMs };
  }
}
