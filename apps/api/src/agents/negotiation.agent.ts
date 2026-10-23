import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentAuditContext,
  AgentPurpose,
  FeedbackDelta,
  NegotiationMessage,
  NegotiationResult,
  UserProfile,
  WantedProfile,
} from "@wingman/shared";
import { NEGOTIATION_PROMPT } from "./prompts/negotiation";
import { createSaveScoreTool } from "./tools/saveScore";
import { runAgentQuery } from "./agentSdkClient";
import { NEGOTIATION_MODEL } from "./models";

// See docs/adr/0011 — migrated off the raw Messages API onto the Claude Agent
// SDK so dev/local runs can authenticate via a Claude Code OAuth login
// instead of requiring ANTHROPIC_API_KEY. Supersedes docs/adr/0003.
// Negotiation is a separate actor from BarneyAgent (no tools, no user
// session, no mode); it deliberately does not reuse BarneyAgent.
// See docs/adr/0007 for the prompt; model id lives in models.ts (#303).

// Each agent asks up to 4 questions; the two alternate for 8 turns total.
export const QUESTIONS_PER_AGENT = 4;
export const TOTAL_TURNS = QUESTIONS_PER_AGENT * 2;

// A match requires BOTH agents to independently score at or above this bar.
export const MATCH_THRESHOLD = 7;

interface Turn {
  role: "user" | "assistant";
  text: string;
}

function formatTranscript(history: Turn[]): string {
  return history
    .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`)
    .join("\n\n");
}

// One participant in a negotiation. #40 never touches the DB — the caller (#45)
// loads the User + profiles and passes them in. `name` comes from User.name and
// becomes the agent's log label ("{name}'s agent").
export interface NegotiationParticipant {
  userId: string;
  name: string;
  // The human's own gender, from User.gender (#317). UserProfile deliberately
  // has no gender field, so without this the agents were left to infer their
  // human's gender from wantedProfile.genderPreference — and hallucinated
  // vetoes on pairs the deterministic filter had already gender-verified.
  gender: string;
  profile: UserProfile;
  wanted: WantedProfile;
  // Lessons from this human's past Blind Dates (issue #299): every
  // FeedbackRound.delta merged oldest-to-newest by delta.service#mergeDeltas.
  // Optional so eval fixtures and force-match paths that predate feedback
  // wiring keep working; an all-empty delta is treated the same as absent.
  feedback?: FeedbackDelta;
}

// Holds one side's conversation. Stateful: its history carries the full
// alternating transcript (own turns as assistant, the counterpart's as user)
// so every call has complete context to ask sharper follow-ups.
export class NegotiationAgent {
  private readonly history: Turn[] = [];
  // Eval-only (#250) — see getUsage().
  private totalCostUsd = 0;
  private totalDurationMs = 0;
  // One entry per protocol-guard re-ask fired on this agent's turns (#422) —
  // the violation kinds that triggered it. Previously console.warn-only; see
  // getGuardFirings().
  private readonly guardFirings: string[][] = [];

  constructor(
    private readonly systemPrompt: string,
    // The human this agent negotiates for. Carried solely so every call this
    // agent makes is attributed on AgentCall (docs/adr/0038, #553) — the agent
    // itself never reads it. Null for a run with no real user behind it (an
    // eval fixture pair), which is why it is nullable rather than absent.
    private readonly userId: string | null,
    // Overrides the production NEGOTIATION_MODEL — only the eval dashboard
    // (#250) sets this, to run Track 2 negotiation under a chosen model tier.
    private readonly modelOverride?: string,
    // Eval-only (#424): also re-ask on `staged-qa-exchange`, the quiet kind that
    // ships detection-only. Exists solely so the A/B harness can run both arms
    // of the guard from one code path. Never set in production — see
    // NegotiationConfig.guardQuietVentriloquism.
    private readonly guardQuietVentriloquism = false
  ) {}

  private recordUsage(costUsd: number, durationMs: number): void {
    this.totalCostUsd += costUsd;
    this.totalDurationMs += durationMs;
  }

  // The AgentCall attribution for one of this agent's calls (docs/adr/0038).
  private audit(purpose: AgentPurpose): AgentAuditContext {
    return { actor: "negotiation", purpose, userId: this.userId };
  }

  // Real Anthropic API cost/time spent across every call so far on this
  // instance. Eval-only (#250) — production callers never read this.
  getUsage(): { costUsd: number; durationMs: number } {
    return { costUsd: this.totalCostUsd, durationMs: this.totalDurationMs };
  }

  // The violation kinds behind each protocol-guard re-ask this agent paid for
  // (#422). runNegotiation folds these into NegotiationResult.guardRetries so
  // the guard's false-positive rate is auditable from the eval JSON alone.
  getGuardFirings(): string[][] {
    return this.guardFirings;
  }

  async turn(
    incoming: string,
    captureThinking = false
  ): Promise<{ text: string; thinking: string }> {
    this.history.push({ role: "user", text: incoming });

    const first = await runAgentQuery({
      logLabel: "NegotiationAgent",
      systemPrompt: this.systemPrompt,
      prompt: formatTranscript(this.history),
      model: this.modelOverride ?? NEGOTIATION_MODEL,
      captureThinking,
      audit: this.audit("negotiation_turn"),
    });
    this.recordUsage(first.costUsd, first.durationMs);
    let text = first.text;
    let thinking = first.thinking;

    // Protocol guard (#420): if the reply states a score or stages the other
    // agent's turn, re-ask ONCE to rewrite it — this keeps the leaked number
    // from reaching (and anchoring) the other agent and keeps the fabrication
    // out of deliberationLog. One bounded retry; anything that still violates
    // is surfaced by the eval harness rather than silently trusted.
    //
    // Detect on the STRIPPED content, not the raw reply: models routinely echo
    // the benign framing line "The other agent responded:" (that's why
    // stripFraming exists), and detecting on raw text would fire on every such
    // echo and pay to retry a perfectly good turn. Genuine gc10-style
    // fabrication ("The other agent responded WITH THE SCORE: 7") is mid-block
    // paraphrase that survives stripping, so it's still caught.
    // Only the CONTAMINATING kinds re-ask (#422). `staged-qa-exchange` is
    // detection-only: two 10-couple sweeps with it driving re-asks measured
    // match-decision accuracy at 16/20 against 20/20 without it, gc10 flipping
    // from a correct no-match to a 2-for-2 false positive, and 55% of couples
    // STILL carrying surviving ventriloquism — it cost accuracy without buying
    // clean transcripts. It is still recorded (see quietViolations in
    // Track2LogRecord), just no longer allowed to disturb the negotiation.
    // See docs/adr/0030 and docs/evidence/track2-eval-run/2026-07-26T17-*.
    //
    // That verdict came from an uncontrolled comparison, so #424 re-tests it as
    // a paired A/B; `guardQuietVentriloquism` widens this filter to include the
    // quiet kind for the experimental arm only. Default false = shipped
    // behaviour, so production and the normal eval path are unaffected.
    const retryable = this.guardQuietVentriloquism
      ? [...CONTAMINATING_VIOLATION_KINDS, "staged-qa-exchange"]
      : CONTAMINATING_VIOLATION_KINDS;
    const violations = detectTurnViolations(stripFraming(stripSentinel(text))).filter((kind) =>
      retryable.includes(kind)
    );
    if (violations.length > 0) {
      // Logged so the false-positive rate is visible as a line, not as silent
      // cost drift (#420). With detection on cleaned content this should be rare.
      console.warn(
        `NegotiationAgent: turn tripped the protocol guard (${violations.join(", ")}) — re-asking once`
      );
      this.guardFirings.push(violations);
      this.history.push({ role: "assistant", text });
      this.history.push({ role: "user", text: TURN_PROTOCOL_REASK });
      const retry = await runAgentQuery({
        logLabel: "NegotiationAgent",
        systemPrompt: this.systemPrompt,
        prompt: formatTranscript(this.history),
        model: this.modelOverride ?? NEGOTIATION_MODEL,
        captureThinking,
        audit: this.audit("negotiation_turn"),
      });
      this.recordUsage(retry.costUsd, retry.durationMs);
      text = retry.text;
      thinking = retry.thinking;
    }

    this.history.push({ role: "assistant", text });
    return { text, thinking };
  }

  // Pushes a closing note into this agent's history before it scores, without
  // an API call. Used when the negotiation ends early because the OTHER agent
  // confirmed a dealbreaker of their human is unmet (#420, P3): the surviving
  // agent never took another turn, so without this it would score without
  // the closing context. Recorded as a user turn so it's in context for score().
  noteClosing(text: string): void {
    this.history.push({ role: "user", text });
  }

  // Elicits this agent's independent 1-10 score for its own human. The Agent
  // SDK has no forced tool_choice (see docs/adr/0011), so this prompts the
  // model to call saveScore and re-asks once if it doesn't comply — mirroring
  // the raw SDK's one-retry-then-throw ZodError handling, but the failure
  // mode here is "didn't call the tool" rather than "called it with bad
  // input" (the SDK validates input against the schema before invoking the
  // handler, so a structurally invalid call never reaches us).
  async score(): Promise<{ score: number; rationale: string }> {
    this.history.push({ role: "user", text: SCORING_INSTRUCTION });
    return this.requestScore(/* isRetry */ false);
  }

  private async requestScore(isRetry: boolean): Promise<{ score: number; rationale: string }> {
    let captured: { score: number; rationale: string } | null = null;
    const saveScoreTool = createSaveScoreTool((input) => {
      captured = input;
    });
    const server = createSdkMcpServer({ name: "wingman", tools: [saveScoreTool] });

    const { text, costUsd, durationMs } = await runAgentQuery({
      logLabel: "NegotiationAgent",
      systemPrompt: this.systemPrompt,
      prompt: formatTranscript(this.history),
      model: this.modelOverride ?? NEGOTIATION_MODEL,
      mcpServers: { wingman: server },
      allowedTools: ["mcp__wingman__saveScore"],
      maxTurns: 3,
      audit: this.audit("negotiation_score"),
    });
    this.recordUsage(costUsd, durationMs);

    if (captured) {
      this.history.push({
        role: "assistant",
        text: `[called saveScore: ${JSON.stringify(captured)}]`,
      });
      return captured as { score: number; rationale: string };
    }

    this.history.push({ role: "assistant", text: text || "(no tool call)" });

    if (isRetry) {
      throw new Error("NegotiationAgent: model did not call saveScore despite the re-ask");
    }
    this.history.push({ role: "user", text: SCORING_REASK });
    return this.requestScore(/* isRetry */ true);
  }

  // Eval-only (proving the relayClosingToOpener fix): score against a
  // hypothetical extension of this agent's history WITHOUT mutating it, so the
  // same transcript can be scored under two counterfactuals — blind to the
  // closing turn vs. seeing it — for a controlled A/B that cancels the ~±2
  // negotiation noise. Mirrors score()'s one-retry-then-throw contract but
  // leaves this.history (and thus any subsequent real score()) untouched.
  async scoreSnapshot(
    extraUserTurns: string[] = []
  ): Promise<{ score: number; rationale: string }> {
    const history: Turn[] = [
      ...this.history,
      ...extraUserTurns.map((text) => ({ role: "user" as const, text })),
      { role: "user" as const, text: SCORING_INSTRUCTION },
    ];
    return this.requestScoreFrom(history, /* isRetry */ false);
  }

  private async requestScoreFrom(
    history: Turn[],
    isRetry: boolean
  ): Promise<{ score: number; rationale: string }> {
    let captured: { score: number; rationale: string } | null = null;
    const saveScoreTool = createSaveScoreTool((input) => {
      captured = input;
    });
    const server = createSdkMcpServer({ name: "wingman", tools: [saveScoreTool] });

    const { text, costUsd, durationMs } = await runAgentQuery({
      logLabel: "NegotiationAgent",
      systemPrompt: this.systemPrompt,
      prompt: formatTranscript(history),
      model: this.modelOverride ?? NEGOTIATION_MODEL,
      mcpServers: { wingman: server },
      allowedTools: ["mcp__wingman__saveScore"],
      maxTurns: 3,
      audit: this.audit("negotiation_score"),
    });
    this.recordUsage(costUsd, durationMs);

    if (captured) return captured as { score: number; rationale: string };
    if (isRetry) {
      throw new Error(
        "NegotiationAgent: model did not call saveScore despite the re-ask (snapshot)"
      );
    }
    return this.requestScoreFrom(
      [
        ...history,
        { role: "assistant", text: text || "(no tool call)" },
        { role: "user", text: SCORING_REASK },
      ],
      /* isRetry */ true
    );
  }

  // Called only after score(). Writes a human-readable compatibility summary
  // for the matched pair.
  async writeRationale(): Promise<string> {
    if (this.history.length === 0) {
      throw new Error("NegotiationAgent: writeRationale called before score()");
    }
    this.history.push({ role: "user", text: RATIONALE_INSTRUCTION });

    const { text, costUsd, durationMs } = await runAgentQuery({
      logLabel: "NegotiationAgent",
      systemPrompt: this.systemPrompt,
      prompt: formatTranscript(this.history),
      model: this.modelOverride ?? NEGOTIATION_MODEL,
      audit: this.audit("negotiation_rationale"),
    });
    this.recordUsage(costUsd, durationMs);

    if (!text.trim()) {
      throw new Error("NegotiationAgent: writeRationale got no text from the model");
    }

    this.history.push({ role: "assistant", text });
    return text;
  }
}

// Prompt redacted in the public showcase version.
export function earlyExitSurvivorNote(finalMessage: string): string {
  return `EARLY_EXIT_REDACTED
${finalMessage}`;
}

const SCORING_INSTRUCTION = "SCORING_REDACTED";

const SCORING_REASK = "SCORING_REASK_REDACTED";

const RATIONALE_INSTRUCTION = "RATIONALE_REDACTED";

// Writes a warm, honest rationale for a "best-available" fallback pairing
// (#chat-flow #8) — a pair that did NOT clear the mutual score threshold but is
// matched anyway so the user always has someone to meet. Standalone (no prior
// negotiation history required): one call from agent A's matchmaker perspective,
// given the other person's profile. Kept separate from writeRationale(), which
// only runs after a genuine, threshold-clearing negotiation.
export async function writeFallbackRationale(
  a: NegotiationParticipant,
  b: NegotiationParticipant
): Promise<string> {
  const partnerProfile = JSON.stringify({ userProfile: b.profile }, null, 2);
  const { text } = await runAgentQuery({
    logLabel: "NegotiationAgent",
    systemPrompt: formatProfileContext(a),
    prompt: ["Prompt redacted in the public showcase version.", partnerProfile].join("\n"),
    model: NEGOTIATION_MODEL,
    audit: { actor: "negotiation", purpose: "fallback_rationale", userId: a.userId },
  });
  if (!text.trim()) {
    throw new Error("NegotiationAgent: writeFallbackRationale got no text from the model");
  }
  return text.trim();
}

// True when at least one lesson exists — an all-empty merge (user has no
// FeedbackRounds, or every round was empty) must serialize to nothing so
// pre-first-date negotiations stay byte-identical to the historical format.
function hasFeedback(delta: FeedbackDelta | undefined): delta is FeedbackDelta {
  return (
    !!delta &&
    (delta.addedDealbreakers.length > 0 ||
      delta.removedDealbreakers.length > 0 ||
      delta.removedPreferences.length > 0 ||
      delta.addedPreferences.length > 0 ||
      delta.compromiseUpdates.length > 0)
  );
}

// Deterministic JSON serialization of one participant's own data — UserProfile +
// WantedProfile plus, when present, the merged feedback from their past Blind
// Dates (issue #299). No LLM call, so a test can prove each agent's system prompt
// contains only its own human's data. Exported so the groundedness judge (issue
// #336) can grade an agent's claims against the exact same profile the agent
// itself was briefed with, from a single source of truth.
export function serializeParticipantProfile(participant: NegotiationParticipant): string {
  return JSON.stringify(
    {
      // Top-level (not inside userProfile) because UserProfile is a shared
      // Zod-validated shape — injecting a key here would desync it from
      // packages/shared. See #317.
      gender: participant.gender,
      userProfile: participant.profile,
      wantedProfile: participant.wanted,
      ...(hasFeedback(participant.feedback) ? { feedbackFromPastDates: participant.feedback } : {}),
    },
    null,
    2
  );
}

// Interpolates a participant's own serialized profile into the shared
// NEGOTIATION_PROMPT so the agent is briefed only on its own human's data.
export function formatProfileContext(participant: NegotiationParticipant): string {
  const context = serializeParticipantProfile(participant);
  // Use a replacer function, not a string, so literal `$` sequences in the
  // JSON-serialized profile (e.g. a user's free-text answer) are inserted
  // verbatim instead of being interpreted as replacement patterns like $&/$$.
  return NEGOTIATION_PROMPT.replace("{{PROFILE_CONTEXT}}", () => context);
}

const KICKOFF = "KICKOFF_REDACTED";

const RELAY_LINE = "RELAY_REDACTED";
const REPLY_LINE = "REPLY_REDACTED";
const CLOSING_LINE = "CLOSING_REDACTED";

function framedReply(prev: string): string {
  return `${RELAY_LINE}\n${prev}\n${REPLY_LINE}`;
}

// Used only for the incoming message of the final turn — with strict A/B
// alternation the agent speaking last would otherwise be told (via
// framedReply) to ask a new question that nobody answers before scoring
// starts (issue #380). Preserves the even-turns invariant (no odd turn count
// needed) by changing the framing of the last turn instead.
function closingFrame(prev: string): string {
  return `${RELAY_LINE}\n${prev}\n${CLOSING_LINE}`;
}

// Thrown by runNegotiation when any turn (negotiation, scoring, or rationale)
// fails after retries are already exhausted one layer down (agentSdkClient's
// own bounded retry — see docs/adr/0011). Carries whatever was built before
// the throw so the caller can persist it instead of discarding paid API spend
// (#339) — deliberationLog may be partial (a mid-loop failure) or complete
// (a failure during scoring/rationale, after every negotiation turn
// succeeded); costUsd/durationMs reflect only what actually ran.
export class NegotiationTurnFailure extends Error {
  constructor(
    message: string,
    public readonly deliberationLog: NegotiationMessage[],
    public readonly costUsd: number,
    public readonly durationMs: number,
    public readonly turnError: unknown
  ) {
    super(message);
    this.name = "NegotiationTurnFailure";
  }
}

// Emitted by an agent (see the ENDING EARLY section of NEGOTIATION_PROMPT)
// once it is genuinely certain a dealbreaker is violated and unresolved —
// lets the loop stop before all turns run instead of paying for dead
// conversation after the match has already failed the Dealbreaker Gate (#338).
// Stripped from the logged/relayed content so it never leaks into the
// transcript a human or the other agent's history actually reads.
export const DEALBREAKER_CONFIRMED_SENTINEL = "[DEALBREAKER_CONFIRMED]";

function stripSentinel(reply: string): string {
  return reply.replaceAll(DEALBREAKER_CONFIRMED_SENTINEL, "").trim();
}

// The relay wrapper (framedReply) and formatTranscript's "User:"/"Assistant:"
// prefixes are scaffolding fed to the model, not content. Models sometimes echo
// them back into their own reply, which then lands verbatim in deliberationLog
// and pollutes every downstream judge pass and the eval transcript view (#399).
// Strip them from each reply before it is logged or relayed, so the stored
// content is only the agent's own words. Line-oriented and conservative: only
// removes a leading speaker prefix and lines that are exactly the framing
// sentences, never anything the agent actually said.
const FRAMING_LINES = new Set([RELAY_LINE, REPLY_LINE, CLOSING_LINE]);

// Any line the model echoes that STARTS with one of these framing openers is
// scaffolding, not content — exact-line matching misses paraphrased/truncated
// echoes (a real run logged a garbled "…then ask one contiesponse"), so
// prefix-strip them too. The second entry is the protocol-guard re-ask (#420),
// itself scaffolding pushed into history that models echo back.
const FRAMING_LINE_PREFIXES = [REPLY_LINE, CLOSING_LINE, "TURN_PROTOCOL_REDACTED"];

// Turn-level protocol guard (#420). Prompt instruction alone demonstrably
// cannot stop an agent from (a) stating a numeric score mid-negotiation —
// which breaks score independence when the other agent reads and anchors on it
// — or (b) staging the other agent's turn (inventing its answers, a whole
// fabricated scoring ceremony) which then pollutes every downstream judge.
// This detector flags both from a single reply; runNegotiation re-asks once
// when it fires, and the eval harness records anything that survives. Pure and
// exported for unit testing.
export function detectTurnViolations(text: string): string[] {
  const violations: string[] = [];
  // A line that is just a 1-10 number — an agent leading with its score.
  if (/^\s*(?:10|[1-9])\s*$/m.test(text)) violations.push("bare-score-line");
  // An explicit numeric score statement, or a fabricated aggregate ceremony.
  if (
    /\b(?:my |final |match |overall )?score\s*(?:is|:|=|of)?\s*(?:10|[1-9])\b/i.test(text) ||
    /\bmatch score\b/i.test(text) ||
    /\baverage of\s*\d/i.test(text)
  ) {
    violations.push("score-statement");
  }
  // Staging / inventing the other agent's turn or its score.
  if (
    /\bthe other agent responded\b/i.test(text) ||
    /\bresponded with (?:the |a )?score\b/i.test(text) ||
    /\bBarney says\b/i.test(text)
  ) {
    violations.push("staged-other-side");
  }
  // Quiet ventriloquism (issue #422): a turn that stages a whole Q&A exchange —
  // asks a question, writes an answer (inventing the other side's reply, often
  // complete with "My human ..." framing), then asks again. The loud detectors
  // above miss this because nothing is framed as the other agent speaking. A
  // protocol-clean turn answers first and ENDS with its single question, so a
  // question line followed by substantive prose and then another question line
  // can only be a staged exchange. Line-level and conservative: only lines
  // ending with "?" count as questions (an inline rhetorical "does she avoid
  // it? No —" stays prose), adjacent question lines (a multi-part question)
  // never fire, and prose trailing the final question never fires.
  let sawQuestion = false;
  let sawAnswerAfterQuestion = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.endsWith("?")) {
      if (sawQuestion && sawAnswerAfterQuestion) {
        violations.push("staged-qa-exchange");
        break;
      }
      sawQuestion = true;
    } else if (sawQuestion && line.length >= 20) {
      sawAnswerAfterQuestion = true;
    }
  }
  return violations;
}

// Violations that mark a transcript as contaminated. A staged Q&A exchange is
// recorded separately (`quietViolations`) and is not in this list.
export const CONTAMINATING_VIOLATION_KINDS: readonly string[] = [
  "bare-score-line",
  "score-statement",
  "staged-other-side",
];

// Corrective re-ask when a turn trips a contaminating protocol violation.
// The instruction text is redacted in the public showcase version.
const TURN_PROTOCOL_REASK = "TURN_PROTOCOL_REDACTED";

function stripFraming(reply: string): string {
  return reply
    .split("\n")
    .map((line) => line.replace(/^\s*(?:User|Assistant):\s*/i, ""))
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !FRAMING_LINES.has(trimmed) && !FRAMING_LINE_PREFIXES.some((p) => trimmed.startsWith(p))
      );
    })
    .join("\n")
    .trim();
}

// Drives the deterministic 8-turn alternation between two agents, then each
// agent independently scores the match. A (first argument) opens negotiation;
// the two alternate until TOTAL_TURNS messages are logged, or until either
// agent confirms a dealbreaker violation (#338), whichever comes first. Returns
// the complete result, or throws NegotiationTurnFailure carrying whatever
// partial log/spend was produced before a turn failed (#339).
export interface NegotiationConfig {
  // Overrides TOTAL_TURNS (must stay even — turns alternate strictly A/B).
  // Only the eval dashboard's run config (#250) sets this.
  turns?: number;
  // Overrides the production NEGOTIATION_MODEL for both agents. Eval-only.
  model?: string;
  // Eval-only (#420): capture each agent turn's extended-thinking reasoning
  // into deliberationLog. Off in production.
  captureThinking?: boolean;
  // Which side speaks first. Defaults to "a", preserving production behavior
  // (A always opened). The eval harness alternates this per couple (#420, P7b)
  // so the first-mover advantage — the opener probes dealbreakers first and
  // terminates first — averages out of the aggregate meanA/meanB instead of
  // always favoring A. Does not change which agent's score is scoreA/scoreB.
  openerSide?: "a" | "b";
  // Relay the closing turn into the opener's history before it scores. On a
  // full-length negotiation the final turn is logged but never relayed — the
  // loop exits before the opener would take its next turn — so the opener would
  // otherwise score BLIND to the closer's last message (often the answer to the
  // opener's own final question), manufacturing a phantom "unresolved concern".
  // Defaults to true (the fix). A probe sets it false to reproduce the old
  // blind-opener behavior for a controlled comparison.
  relayClosingToOpener?: boolean;
  // Eval-only: score the opener BOTH ways off the identical transcript (blind
  // vs. seeing the closing turn) so the ~±2 negotiation noise cancels, proving
  // the relayClosingToOpener fix in isolation. Returns the extra scores on the
  // result (blindOpenerScore/fixedOpenerScore). Never set in production.
  debugOpenerScoreComparison?: boolean;
  // Eval-only (#424): also re-ask on `staged-qa-exchange`. That kind ships
  // detection-only because #422 measured it costing match-decision accuracy,
  // but that verdict came from comparing sweeps run days apart under different
  // code — three variables at once. This flag is the experimental arm of the
  // paired A/B that re-tests it properly (`scripts/abGuardExperiment.ts`).
  // Defaults to false = shipped behaviour. Never set in production.
  guardQuietVentriloquism?: boolean;
}

export async function runNegotiation(
  a: NegotiationParticipant,
  b: NegotiationParticipant,
  config: NegotiationConfig = {}
): Promise<NegotiationResult> {
  const agentA = new NegotiationAgent(
    formatProfileContext(a),
    a.userId,
    config.model,
    config.guardQuietVentriloquism
  );
  const agentB = new NegotiationAgent(
    formatProfileContext(b),
    b.userId,
    config.model,
    config.guardQuietVentriloquism
  );
  const totalTurns = config.turns ?? TOTAL_TURNS;

  const deliberationLog: NegotiationMessage[] = [];
  let incoming = KICKOFF;
  // Whoever opens takes the even turns. Default "a" keeps production's A-opens
  // behavior; the eval harness flips this per couple to cancel the first-mover
  // bias (#420, P7b). Agent identity (agentA/scoreA) is unchanged either way.
  const aOpens = (config.openerSide ?? "a") === "a";

  const relayClosingToOpener = config.relayClosingToOpener ?? true;
  let endedEarly = false;

  // Folds both agents' guard firings into the result (#422), attributed by
  // speaker label. Interleaved order across the two agents isn't preserved —
  // the eval only needs the count and per-firing kinds.
  const collectGuardRetries = (): { speaker: string; kinds: string[] }[] => [
    ...agentA.getGuardFirings().map((kinds) => ({ speaker: `${a.name}'s agent`, kinds })),
    ...agentB.getGuardFirings().map((kinds) => ({ speaker: `${b.name}'s agent`, kinds })),
  ];

  try {
    for (let turn = 0; turn < totalTurns; turn++) {
      const isAgentA = (turn % 2 === 0) === aOpens;
      const speaker = isAgentA ? a : b;
      const agent = isAgentA ? agentA : agentB;

      const { text: reply, thinking } = await agent.turn(incoming, config.captureThinking ?? false);
      // turn 0 is always the opening question (KICKOFF), never a response to
      // the other side — an agent cannot have confirmed anything yet, so the
      // sentinel is only honored from turn 1 onward, once an actual answer
      // exists to confirm it against.
      const dealbreakerConfirmed = turn > 0 && reply.includes(DEALBREAKER_CONFIRMED_SENTINEL);
      const sentinelStripped = reply.includes(DEALBREAKER_CONFIRMED_SENTINEL)
        ? stripSentinel(reply)
        : reply;
      // Strip any echoed relay/prefix scaffolding so deliberationLog holds only
      // the agent's own words (#399) — this content is both logged and relayed
      // to the other agent as the next `incoming`.
      const content = stripFraming(sentinelStripped);
      deliberationLog.push({
        speaker: `${speaker.name}'s agent`,
        content,
        ...(config.captureThinking && thinking ? { thinking } : {}),
      });
      if (dealbreakerConfirmed) {
        // The emitter (`agent`) confirmed a dealbreaker is violated, then the
        // loop breaks before this message is relayed. Hand the survivor the
        // actual (sentinel-stripped) killing message so it scores from evidence
        // and picks the correct cap, instead of scoring blind (#420, P3).
        const survivor = agent === agentA ? agentB : agentA;
        survivor.noteClosing(earlyExitSurvivorNote(content));
        endedEarly = true;
        break;
      }
      const nextTurnIsLast = turn + 1 === totalTurns - 1;
      incoming = nextTurnIsLast ? closingFrame(content) : framedReply(content);
    }

    // Relay the closing turn into the opener's history before it scores. After
    // a full-length negotiation `incoming` holds framedReply(<closer's final
    // turn>) — the message the opener would have received on its next turn, the
    // one the loop never ran. Without this the opener scores blind to the
    // closer's last answer (see relayClosingToOpener). Skipped on an early
    // dealbreaker exit, where the survivor already got noteClosing above and no
    // final turn was withheld. The opener is the turn-0 speaker: agentA iff aOpens.
    // Eval-only controlled proof of the relayClosingToOpener fix: score the
    // opener BOTH ways off the identical transcript — blind (pre-fix) vs. with
    // the closing turn relayed (post-fix) — via non-mutating snapshots, so the
    // ~±2 negotiation noise cancels and any delta is purely the fix. Returns
    // the extra scores on the result. Never runs in production.
    if (config.debugOpenerScoreComparison && !endedEarly) {
      const opener = aOpens ? agentA : agentB;
      const closer = aOpens ? agentB : agentA;
      const blind = await opener.scoreSnapshot([]);
      const fixed = await opener.scoreSnapshot([incoming]);
      const closerRes = await closer.scoreSnapshot([]);
      const scoreA = aOpens ? fixed.score : closerRes.score;
      const scoreB = aOpens ? closerRes.score : fixed.score;
      const usageA = agentA.getUsage();
      const usageB = agentB.getUsage();
      return {
        deliberationLog,
        scoreA,
        scoreB,
        matched: scoreA >= MATCH_THRESHOLD && scoreB >= MATCH_THRESHOLD,
        rationale: null,
        rationaleA: aOpens ? fixed.rationale : closerRes.rationale,
        rationaleB: aOpens ? closerRes.rationale : fixed.rationale,
        costUsd: usageA.costUsd + usageB.costUsd,
        durationMs: usageA.durationMs + usageB.durationMs,
        guardRetries: collectGuardRetries(),
        // Eval-only extras — not part of NegotiationResult's schema.
        blindOpenerScore: blind.score,
        fixedOpenerScore: fixed.score,
        openerIsAgentA: aOpens,
      } as unknown as NegotiationResult;
    }

    if (relayClosingToOpener && !endedEarly) {
      const opener = aOpens ? agentA : agentB;
      opener.noteClosing(incoming);
    }

    // Independent by construction: each agent only ever sees its own history,
    // never the other's score. Run in parallel — they are unrelated I/O calls.
    const [resultA, resultB] = await Promise.all([agentA.score(), agentB.score()]);
    const scoreA = resultA.score;
    const scoreB = resultB.score;
    const matched = scoreA >= MATCH_THRESHOLD && scoreB >= MATCH_THRESHOLD;

    // Both agents write their own half (issue #340) — each is only ever
    // grounded in its own human's profile, so a single-agent rationale was
    // necessarily one-sided. Run in parallel, same as scoring above.
    const rationale = matched
      ? (await Promise.all([agentA.writeRationale(), agentB.writeRationale()])).join("\n\n")
      : null;

    const usageA = agentA.getUsage();
    const usageB = agentB.getUsage();

    return {
      deliberationLog,
      scoreA,
      scoreB,
      matched,
      rationale,
      rationaleA: resultA.rationale,
      rationaleB: resultB.rationale,
      costUsd: usageA.costUsd + usageB.costUsd,
      durationMs: usageA.durationMs + usageB.durationMs,
      guardRetries: collectGuardRetries(),
    };
  } catch (error) {
    const usageA = agentA.getUsage();
    const usageB = agentB.getUsage();
    throw new NegotiationTurnFailure(
      `runNegotiation: a turn failed — ${error instanceof Error ? error.message : String(error)}`,
      deliberationLog,
      usageA.costUsd + usageB.costUsd,
      usageA.durationMs + usageB.durationMs,
      error
    );
  }
}
