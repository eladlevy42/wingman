import type { ZodError } from "zod";
import type {
  EngineSnapshot,
  InputDescriptor,
  InterviewLanguage,
  InterviewProgress,
  InterviewSection,
} from "@wingman/shared";
import { DEFAULT_INTERVIEW_LANGUAGE } from "@wingman/shared";
import type { InterviewSectionDef, QuestionNode } from "./questionTree";
import { resolveInput, t, type AddressForm } from "./localized";
import { engineCopy, type EngineCopy } from "./engineCopy";
import { runSoftTurn, type SoftTurnFn, type SoftTurnResult } from "./softTurn";
import { answerSideQuestion, looksLikeQuestion, type SideQuestionFn } from "./sideQuestion";
import { routeAddendum, type AddendumFn } from "./addendum";
import { looksLikeSkip, looksLikeBack } from "./navIntent";
import {
  CONFIG_BY_MODE,
  type InterviewConfig,
  type InterviewMode,
  type PersistFn,
} from "./interview.config";

// The deterministic interview engine. See docs/adr/0004. Code owns the flow tree
// and termination; the model (Haiku) only voices replies and makes the one
// narrow "is this answer sufficient?" judgment on soft nodes. No Sonnet, no
// transcript replay — per-turn context is one node + one answer.
//
// The engine core is shape-agnostic: the tree it walks, the copy it speaks, and
// how collected answers become a validated/persisted profile all come from an
// InterviewConfig (interview.config.ts). One engine, applied to both interview
// modes (self and wants) — ADR 0004 point 7.

// Hard cap on probes per question (ADR 0004 point 5). After this many failed
// pushes the engine force-advances regardless of the model's opinion. Lowered
// from 2 to 1 (#417) — one probe still filters a lazy answer, and the
// force-advance safety net already tolerates a thin answer on a non-required
// node, so a second probe was mostly just adding an extra LLM round-trip.
const MAX_PROBES = 1;

export type { PersistFn } from "./interview.config";

export interface InterviewEngineDeps {
  // Selects the config bundle (tree/copy/schema/assemble/persist). Defaults to
  // interview_self so existing call sites and unit tests need no change.
  mode?: InterviewMode;
  runSoftTurn?: SoftTurnFn;
  answerSideQuestion?: SideQuestionFn;
  // The end-of-interview "anything else?" router (#251). Injectable so tests run
  // the wrap-up flow without hitting Haiku.
  routeAddendum?: AddendumFn;
  // Overrides for tests — take precedence over the selected config so a test can
  // run the full flow against a focused tree or a DB-free persist stub.
  persist?: PersistFn;
  tree?: QuestionNode[];
  // The language the interview opens in (ADR-0037). Defaults to Hebrew, the
  // product default, so a caller that says nothing gets the Hebrew interview.
  language?: InterviewLanguage;
  // How Hebrew copy addresses the person (אתה/את/אתם). Known from registration
  // gender before the interview starts; defaults to the neutral plural.
  addressForm?: AddressForm;
}

export interface TurnResult {
  // The acknowledgement and next question joined with a space — the legacy shape
  // any client not consuming the split fields still relies on.
  reply: string;
  phaseComplete: boolean;
  // reply, split so the UI can render Barney's acknowledgement and his next
  // question as two separate bubbles with breathing room. On a probe or a
  // side-question turn there is no acknowledgement, so it is null and `question`
  // carries the probe / answer text.
  acknowledgement: string | null;
  question: string | null;
  // Metadata describing the question the user should now respond to, for the
  // richer chat UI. section is null when the mode defines no sections.
  section: InterviewSection | null;
  progress: InterviewProgress;
  input: InputDescriptor;
}

export class InterviewEngine {
  private readonly config: InterviewConfig;
  private readonly tree: QuestionNode[];
  private readonly sections?: InterviewSectionDef[];
  private readonly softTurn: SoftTurnFn;
  private readonly sideQuestion: SideQuestionFn;
  private readonly addendum: AddendumFn;
  private readonly persist: PersistFn;
  // The language every reply this engine writes is in. Mutable because the
  // flag toggle can flip it mid-interview: the next turn's question, probe and
  // acknowledgement are simply rendered from the other side of the same tree,
  // and nothing already collected changes (extracted values are English in
  // both languages — see softTurn.ts).
  private language: InterviewLanguage;
  // Fixed for the session's life: gender is known from registration and does
  // not change mid-interview the way the language toggle can.
  private readonly address: AddressForm;

  private started = false;
  private done = false;
  private currentIndex = -1;
  private probesUsed = 0;
  // Ordered stack of the DISTINCT question nodes actually presented to the user
  // (probes/side-questions re-show the same node and are not pushed). Powers
  // "go back": the last entry is the current question, the one before it is where
  // "back" returns to. See goBack().
  private readonly history: number[] = [];
  // True once the whole tree is answered and Barney has offered the "anything
  // else?" wrap-up turn (#251) — the next user message is routed as an addendum,
  // not a tree answer.
  private awaitingAddendum = false;
  // True once the wrap-up recap has been shown. If finalize() later re-asks a
  // field (an invalid value) and the tree completes again, we finalize directly
  // rather than repeating the "anything else?" recap.
  private wrapupOffered = false;
  private readonly collected: Record<string, unknown> = {};
  // The interview as it actually happened, one line per turn, in order (#488).
  // ADR-0004 keeps no conversation history for *context* — per-turn context is
  // still one node plus one answer, and nothing here is ever replayed to a
  // model. This is a write-only record, assembled as turns are emitted and
  // persisted once at finalize(), so a wrong extraction can be read back
  // against what the user was actually responding to. Probes, side questions,
  // skips and back-navigation all land here because every reply leaves through
  // turn()/enterWrapup() and every answer arrives through handleMessage().
  private readonly transcript: string[] = [];

  constructor(
    private readonly userId: string,
    deps: InterviewEngineDeps = {}
  ) {
    this.config = CONFIG_BY_MODE[deps.mode ?? "interview_self"];
    this.tree = deps.tree ?? this.config.tree;
    this.sections = this.config.sections;
    this.softTurn = deps.runSoftTurn ?? runSoftTurn;
    this.sideQuestion = deps.answerSideQuestion ?? answerSideQuestion;
    this.addendum = deps.routeAddendum ?? routeAddendum;
    this.persist = deps.persist ?? this.config.persist;
    this.language = deps.language ?? DEFAULT_INTERVIEW_LANGUAGE;
    this.address = deps.addressForm ?? "plural";
  }

  // Switches the language the interview is conducted in from the next reply
  // onward. Idempotent, and safe at any point in the flow.
  setLanguage(language: InterviewLanguage): void {
    this.language = language;
  }

  getLanguage(): InterviewLanguage {
    return this.language;
  }

  // Re-renders what the user is currently being asked, in the current language,
  // without advancing anything. setLanguage() only reaches the next reply, so
  // the question already on screen — and its answer chips — would otherwise
  // stay in the language the user just switched away from until they answer
  // it. Null before the first turn and after completion: nothing is pending.
  //
  // On a probe or a side-question turn this restates the node's own question
  // rather than the model-written reply, which cannot be re-rendered without
  // another model call; the question is what the user still owes an answer to.
  restatePending(): TurnResult | null {
    if (!this.started || this.done) return null;
    if (this.awaitingAddendum) {
      const question = this.wrapupQuestion();
      this.recordBarney(question);
      return {
        reply: question,
        phaseComplete: false,
        acknowledgement: null,
        question,
        section: null,
        progress: { answered: this.tree.length, total: this.tree.length },
        input: { kind: "text" },
      };
    }
    return this.turn({
      acknowledgement: null,
      question: this.questionText(this.tree[this.currentIndex]),
      describeIndex: this.currentIndex,
    });
  }

  // Captures every piece of mutable interview state, so a session can be
  // rehydrated after an api restart (#545). Copies (not references) leave the
  // snapshot frozen at this turn even as the live engine advances. The
  // tree/config/soft-turn deps are deliberately absent: they are deterministic
  // from the session's mode and are rebuilt by whoever constructs the engine
  // that restore() is called on.
  snapshot(): EngineSnapshot {
    return {
      language: this.language,
      started: this.started,
      done: this.done,
      currentIndex: this.currentIndex,
      probesUsed: this.probesUsed,
      history: [...this.history],
      awaitingAddendum: this.awaitingAddendum,
      wrapupOffered: this.wrapupOffered,
      collected: { ...this.collected },
      transcript: [...this.transcript],
      factAckIndex: this.factAckIndex,
    };
  }

  // Rehydrates a freshly constructed engine to the exact turn a snapshot was
  // taken at. Only meaningful on an engine built with the same mode the
  // snapshot came from — the caller (interviewSnapshot.service) guarantees
  // that pairing. The readonly collections are emptied and refilled in place
  // rather than reassigned, which is what keeps them safely `readonly`
  // everywhere else in the class.
  restore(snapshot: EngineSnapshot): void {
    this.language = snapshot.language;
    this.started = snapshot.started;
    this.done = snapshot.done;
    this.currentIndex = snapshot.currentIndex;
    this.probesUsed = snapshot.probesUsed;
    this.history.length = 0;
    this.history.push(...snapshot.history);
    this.awaitingAddendum = snapshot.awaitingAddendum;
    this.wrapupOffered = snapshot.wrapupOffered;
    for (const key of Object.keys(this.collected)) delete this.collected[key];
    Object.assign(this.collected, snapshot.collected);
    this.transcript.length = 0;
    this.transcript.push(...snapshot.transcript);
    this.factAckIndex = snapshot.factAckIndex;
  }

  // Barney's engine-authored copy in the current language.
  private get copy(): EngineCopy {
    return engineCopy(this.language, this.address);
  }

  // A tree node's question text in the current language.
  private questionText(node: QuestionNode): string {
    return t(node.text, this.language, this.address);
  }

  // Drives one turn. The very first call ignores its input and returns the
  // greeting plus the first question — mirroring how the old free-form agent
  // opened, so the client contract (reply + phaseComplete) is unchanged.
  async handleMessage(text: string): Promise<TurnResult> {
    if (this.done) {
      throw new Error("InterviewEngine: interview already complete for this session");
    }
    // Record the user's answer before it is routed. The very first call is a
    // priming call whose input is ignored, so it contributes no line.
    if (this.started) {
      this.transcript.push(`User: ${text}`);
    }
    if (!this.started) {
      this.started = true;
      this.currentIndex = this.nextPlayableIndex(-1);
      this.history.push(this.currentIndex);
      return this.turn({
        acknowledgement: t(this.config.greeting, this.language, this.address),
        question: this.questionText(this.tree[this.currentIndex]),
        describeIndex: this.currentIndex,
      });
    }

    // Navigation intents are honored anywhere in the flow — including at the
    // wrap-up — so a user can always step back to fix an answer.
    if (looksLikeBack(text)) {
      return this.goBack();
    }

    // The whole tree is answered and Barney already offered the wrap-up recap;
    // this message is the user's "anything else?" reply, routed as an addendum
    // (updates a field or saves a note) rather than a tree answer. See #251.
    if (this.awaitingAddendum) {
      return this.handleAddendum(text);
    }

    const node = this.tree[this.currentIndex];

    // Explicit "skip/next/continue": honor it immediately rather than pressing
    // for an answer, so a user is never made to feel cornered (#chat-flow). Only
    // non-required nodes can be skipped — a required fact (age/city/gender bounds)
    // is non-nullable in the schema and falls through to its normal probe.
    if (looksLikeSkip(text) && !(node.kind === "fact" && node.required === true)) {
      return this.skipCurrent();
    }

    // Required fact nodes (age/city/country) are non-nullable in the schema, so
    // they are never force-advanced — a null there would crash final validation.
    // They keep probing until answered. See docs/adr/0004.
    const isRequired = node.kind === "fact" && node.required === true;
    const mustAdvance = !isRequired && this.probesUsed >= MAX_PROBES;

    // Escape hatch from the deterministic flow (see sideQuestion.ts): if the
    // user asks a question instead of answering, hand this one turn to Haiku
    // so it can actually respond, rather than firing the canned fact probe or
    // running it through soft-node sufficiency judgment. Required fact nodes
    // never force-advance, so they can take this detour indefinitely. Every
    // other node kind only gets it while probe budget remains — a side
    // question spends a probe just like an insufficient answer would, so
    // MAX_PROBES still caps how long a user can stall by ending replies in
    // "?" before the engine force-advances. See docs/adr/0004 point 5.
    if (looksLikeQuestion(text) && (isRequired || !mustAdvance)) {
      if (!isRequired) {
        this.probesUsed += 1;
      }
      let reply: string;
      try {
        reply = await this.sideQuestion({
          pendingQuestion: this.questionText(node),
          userQuestion: text,
          language: this.language,
          userId: this.userId,
          addressForm: this.address,
        });
      } catch (error) {
        // See evaluate()'s catch above — same rationale, for the side-question
        // escape hatch (issue #410).
        console.error(
          `InterviewEngine.handleMessage: side question for "${node.field}" failed:`,
          error
        );
        throw error;
      }
      // The pending question is unchanged, so keep describing the current node
      // (its input control stays put); the answer to their aside is the reply.
      return this.turn({
        acknowledgement: null,
        question: reply,
        describeIndex: this.currentIndex,
      });
    }

    const { sufficient, value, message } = await this.evaluate(node, text, mustAdvance);

    if (!sufficient) {
      this.probesUsed += 1;
      // A probe re-asks the same node — no acknowledgement, input stays put.
      return this.turn({
        acknowledgement: null,
        question: message,
        describeIndex: this.currentIndex,
      });
    }

    // Advance: store the extracted value and reset the probe budget.
    (this.collected as Record<string, unknown>)[node.field] = value;
    this.probesUsed = 0;

    const nextIndex = this.nextPlayableIndex(this.currentIndex);
    if (nextIndex === -1) {
      // Offer the "anything else?" recap once; if a re-ask brings us back here,
      // finalize directly instead of repeating it.
      return this.wrapupOffered ? this.finalize(message) : this.enterWrapup(message);
    }
    this.currentIndex = nextIndex;
    this.history.push(nextIndex);
    return this.turn({
      acknowledgement: message,
      question: this.questionText(this.tree[nextIndex]),
      describeIndex: nextIndex,
    });
  }

  // Explicit-skip path (#chat-flow): the user asked to move on, so record no
  // answer (null — assemble() folds this to null/[] like any unanswered field)
  // and advance exactly as a sufficient answer would, minus the pressure.
  private async skipCurrent(): Promise<TurnResult> {
    this.collected[this.tree[this.currentIndex].field] = null;
    this.probesUsed = 0;

    const nextIndex = this.nextPlayableIndex(this.currentIndex);
    if (nextIndex === -1) {
      return this.wrapupOffered
        ? this.finalize(this.copy.skipAckFinal)
        : this.enterWrapup(this.copy.skipAckFinal);
    }
    this.currentIndex = nextIndex;
    this.history.push(nextIndex);
    return this.turn({
      acknowledgement: this.copy.skipAck,
      question: this.questionText(this.tree[nextIndex]),
      describeIndex: nextIndex,
    });
  }

  // "Go back" (#chat-flow): return to the previously presented question so the
  // user can change an answer. Drops the answer to every node from the target
  // onward — not just the current and target history entries — so the target is
  // freshly re-answered and the flow re-derives everything after it, including
  // nodes that were auto-filled via skipIf/inferValue (e.g. country from city)
  // and therefore never entered `history` in the first place. Without this, a
  // stale inferred value would survive the rewind and nextPlayableIndex would
  // treat it as already answered even after the user changes the field it was
  // derived from.
  private goBack(): TurnResult {
    // At the wrap-up there is no live tree node; return to the last real question.
    if (this.awaitingAddendum) {
      this.awaitingAddendum = false;
      const target = this.history[this.history.length - 1];
      this.clearCollectedFrom(target);
      this.currentIndex = target;
      this.probesUsed = 0;
      return this.turn({
        acknowledgement: this.copy.revisitAck,
        question: this.questionText(this.tree[target]),
        describeIndex: target,
      });
    }

    if (this.history.length < 2) {
      // Nothing was presented before the current question.
      return this.turn({
        acknowledgement: null,
        question: this.copy.atFirstQuestion,
        describeIndex: this.currentIndex,
      });
    }

    // Pop the current question off the stack and return to the previous one.
    this.history.pop();
    const target = this.history[this.history.length - 1];
    this.clearCollectedFrom(target);
    this.currentIndex = target;
    this.probesUsed = 0;
    return this.turn({
      acknowledgement: this.copy.backAck,
      question: this.questionText(this.tree[target]),
      describeIndex: target,
    });
  }

  // Drops collected answers for the target node and every node after it in tree
  // order — including skipIf/inferValue-derived fields that were never presented
  // as a question and so never appear in `history`. Fields beyond the previous
  // currentIndex are never in `collected` yet, so this is a no-op for them.
  private clearCollectedFrom(fromIndex: number): void {
    for (let i = fromIndex; i < this.tree.length; i++) {
      delete this.collected[this.tree[i].field];
    }
  }

  // Assembles an enriched TurnResult. `reply` is the acknowledgement and question
  // joined with a space (the legacy shape); the split fields plus section /
  // progress / input drive the richer UI. describeIndex is the node the user
  // should now respond to — it sources the section title and input control.
  private turn(params: {
    acknowledgement: string | null;
    question: string | null;
    describeIndex: number;
    phaseComplete?: boolean;
    fullProgress?: boolean;
  }): TurnResult {
    const {
      acknowledgement,
      question,
      describeIndex,
      phaseComplete = false,
      fullProgress,
    } = params;
    const node = this.tree[describeIndex];
    const reply = [acknowledgement, question].filter((s): s is string => Boolean(s)).join(" ");
    this.recordBarney(reply);
    return {
      reply,
      phaseComplete,
      acknowledgement,
      question,
      section: this.sectionFor(node),
      progress: fullProgress
        ? { answered: this.tree.length, total: this.tree.length }
        : this.currentProgress(),
      input: resolveInput(node.input, this.language, this.address),
    };
  }

  // Appends one of Barney's replies to the transcript. Empty replies (an
  // acknowledgement-less turn with nothing to say) contribute no line.
  private recordBarney(reply: string): void {
    if (reply) {
      this.transcript.push(`Barney: ${reply}`);
    }
  }

  // The recorded interview as one readable block. Persisted at finalize().
  private transcriptText(): string {
    return this.transcript.join("\n");
  }

  // Maps the current node's topic bucket to its 1-based section position, or null
  // when the mode defines no sections (or the bucket isn't among them).
  private sectionFor(node: QuestionNode): InterviewSection | null {
    if (!this.sections) return null;
    const index = this.sections.findIndex((s) => s.bucket === node.bucket);
    if (index === -1) return null;
    return {
      title: t(this.sections[index].title, this.language),
      index: index + 1,
      total: this.sections.length,
    };
  }

  // Questions answered so far (collected fields, including branch-inferred ones)
  // out of the total tree size — an approximation good enough for a progress bar.
  private currentProgress(): InterviewProgress {
    return { answered: Object.keys(this.collected).length, total: this.tree.length };
  }

  // Short acknowledgements for fact nodes, rotated so the interview doesn't
  // repeat "Got it." on every deterministic answer. Soft nodes get their ack
  // from Haiku and never touch this. Cycling by index guarantees no two
  // consecutive fact answers share an ack.
  private factAckIndex = 0;
  private nextFactAck(): string {
    const acks = this.copy.factAcks;
    const ack = acks[this.factAckIndex % acks.length];
    this.factAckIndex += 1;
    return ack;
  }

  // Deterministic for fact nodes, one Haiku call for soft nodes. `message` is an
  // acknowledgment when advancing or a probe when not — never the next question.
  private async evaluate(
    node: QuestionNode,
    answer: string,
    mustAdvance: boolean
  ): Promise<{ sufficient: boolean; value: unknown; message: string }> {
    if (node.kind === "fact") {
      const extraction = node.extract(answer);
      if (extraction.sufficient || mustAdvance) {
        return {
          sufficient: true,
          value: extraction.sufficient ? extraction.value : null,
          message: this.nextFactAck(),
        };
      }
      return {
        sufficient: false,
        value: null,
        message: t(node.probe, this.language, this.address),
      };
    }

    let result: SoftTurnResult;
    try {
      result = await this.softTurn({
        node,
        answer,
        mustAdvance,
        language: this.language,
        addressForm: this.address,
        questionText: this.questionText(node),
        userId: this.userId,
      });
    } catch (error) {
      // Not swallowed — the caller (handleMessage -> barney.message.service ->
      // barney.routes) still needs to see this failure and turn it into a clean
      // error response. Logged here with the field name so an Agent SDK / auth
      // failure (see agentSdkClient's AgentSdkUnavailableError/AgentAuthError,
      // issue #410) is traceable to exactly which soft node was being evaluated,
      // rather than only surfacing as a generic 500 further up the stack.
      console.error(`InterviewEngine.evaluate: soft node "${node.field}" failed:`, error);
      throw error;
    }
    const sufficient = mustAdvance ? true : result.sufficient;
    return {
      sufficient,
      value: sufficient ? result.extracted_value : null,
      message: result.message,
    };
  }

  // The deterministic proposer: the next node in order that is not already
  // answered and whose skip branch does not match the profile gathered so far.
  // Returns -1 when the interview is done. The "already answered" check is what
  // makes finalize()'s re-ask safe: it deletes only the offending field before
  // rewinding currentIndex, so every other already-collected field (including
  // ones force-advanced to null) is skipped here instead of being re-asked and
  // silently overwritten.
  private nextPlayableIndex(fromExclusive: number): number {
    for (let i = fromExclusive + 1; i < this.tree.length; i++) {
      const node = this.tree[i];
      if (node.field in this.collected) continue;
      if (node.skipIf?.(this.collected)) {
        if (node.inferValue) {
          (this.collected as Record<string, unknown>)[node.field] = node.inferValue(this.collected);
        }
        continue;
      }
      return i;
    }
    return -1;
  }

  // The tree is fully answered: instead of persisting immediately, Barney gives a
  // one-line recap of the topics covered and invites a free-form addition (#251).
  // The user's next message is handled by handleAddendum. There is no pending
  // tree node here, so the input is free text and no section is reported.
  private enterWrapup(ack: string): TurnResult {
    this.awaitingAddendum = true;
    this.wrapupOffered = true;
    const question = this.wrapupQuestion();
    const reply = [ack, question].filter((s): s is string => Boolean(s)).join(" ");
    this.recordBarney(reply);
    return {
      reply,
      phaseComplete: false,
      acknowledgement: ack || null,
      question,
      section: null,
      progress: { answered: this.tree.length, total: this.tree.length },
      input: { kind: "text" },
    };
  }

  // The "anything else?" recap in the current language, listing the sections
  // covered when the mode defines them.
  private wrapupQuestion(): string {
    const topics = this.sections?.map((s) => t(s.title, this.language)).join(", ");
    return topics ? this.copy.wrapupWithTopics(topics) : this.copy.wrapupPlain;
  }

  // Routes the user's "anything else?" reply (#251). One narrow Haiku call decides
  // whether it corrects an existing field, is a new free-form note, or is nothing
  // — then the interview finalizes exactly as it would have without the wrap-up.
  // Most tree fields are nullable or default to [], so an existing_field result
  // with a missing value would otherwise assemble into a schema-valid null/empty
  // value and silently overwrite a real prior answer with no re-ask — parseAddendumResult
  // already drops that case to "none", and the `result.value !== undefined` check
  // below is a second line of defense against the same failure mode (#272 review).
  private async handleAddendum(text: string): Promise<TurnResult> {
    this.awaitingAddendum = false;
    const offeredFields = this.tree.filter((n) => n.field in this.collected);
    const knownFields = new Set(offeredFields.map((n) => n.field));
    const result = await this.addendum({
      answer: text,
      language: this.language,
      userId: this.userId,
      fields: offeredFields.map((n) => ({
        field: n.field,
        text: this.questionText(n),
        extractHint: n.kind === "soft" ? n.extractHint : undefined,
        currentValue: this.collected[n.field],
      })),
    });

    let ack = "";
    if (
      result.kind === "existing_field" &&
      result.field &&
      knownFields.has(result.field) &&
      result.value !== undefined
    ) {
      this.collected[result.field] = result.value;
      ack = this.copy.addendumUpdated;
    } else if (result.kind === "new_note" && result.value != null) {
      this.collected.additionalNotes = result.value;
      ack = this.copy.addendumNoted;
    }
    return this.finalize(ack);
  }

  // Deterministic assembly + validate + persist — no LLM (ADR 0004 point 6).
  // config.assemble fills every schema key from what was collected, defaulting to
  // null/empty. Validation is the safety net: if a field is
  // still invalid (e.g. a soft enum the model force-advanced with a best-effort
  // value), the engine re-asks that question instead of throwing — an
  // uncooperative user can never produce an opaque 500 or lose collected data.
  private async finalize(ack: string): Promise<TurnResult> {
    const profile = this.config.assemble(this.collected);

    const parsed = this.config.schema.safeParse(profile);
    if (!parsed.success) {
      const reaskIndex = this.firstInvalidNodeIndex(parsed.error);
      if (reaskIndex !== -1) {
        // Drop the bad value and re-ask with a fresh probe budget. Note: this
        // re-ask is not itself capped — a model that keeps returning an invalid
        // value for a soft field could re-ask across turns indefinitely. It is
        // bounded by user patience, not a tight loop (one re-ask per user turn),
        // and is vanishingly unlikely in practice; an absolute turn ceiling is a
        // possible future hardening.
        delete this.collected[this.tree[reaskIndex].field];
        this.currentIndex = reaskIndex;
        this.probesUsed = 0;
        this.history.push(reaskIndex);
        return this.turn({
          // ack is empty when finalize was reached via a "nothing to add" wrap-up
          // reply (#251); drop the leading space rather than emit "  Before…".
          acknowledgement: [ack, this.copy.beforeLockIn].filter(Boolean).join(" "),
          question: this.questionText(this.tree[reaskIndex]),
          describeIndex: reaskIndex,
        });
      }
      // No tree node maps to the invalid field — a tree/schema mismatch, i.e. a
      // programming error worth surfacing rather than silently swallowing.
      throw parsed.error;
    }

    // Captured before the closing line is emitted, so the record ends on the
    // user's last real answer rather than on Barney signing off.
    await this.persist(this.userId, parsed.data as Record<string, unknown>, this.transcriptText());
    this.done = true;
    return this.turn({
      // Null (not "") when the wrap-up reply had nothing to add, so the UI shows
      // just the closing line, not an empty acknowledgement bubble (#251).
      acknowledgement: ack || null,
      question: t(this.config.closing, this.language, this.address),
      describeIndex: this.currentIndex,
      phaseComplete: true,
      fullProgress: true,
    });
  }

  // Maps a validation failure back to the earliest tree node that can fix it, so
  // the engine knows which question to re-ask. The config translates each error
  // path to a tree field id (e.g. wants folds ["ageRange","max"] → "ageMax").
  private firstInvalidNodeIndex(error: ZodError): number {
    const invalidFields = new Set(
      error.issues.map((issue) => this.config.errorPathToField(issue.path))
    );
    for (let i = 0; i < this.tree.length; i++) {
      if (invalidFields.has(this.tree[i].field)) return i;
    }
    return -1;
  }
}
