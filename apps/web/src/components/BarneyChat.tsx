import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, Check, ChevronLeft } from "lucide-react";
import type {
  AddressForm,
  ChatMessage,
  InputDescriptor,
  InterviewLanguage,
  InterviewProgress,
  InterviewSection,
} from "@wingman/shared";
import {
  MAX_MESSAGE_LENGTH,
  MESSAGE_LENGTH_COUNTER_FROM,
  chatStrings,
  isAtBottom,
  isRtl,
  shouldFollowNewContent,
} from "@wingman/shared";
import LanguageToggle from "@/components/LanguageToggle";
import { cn } from "@/lib/utils";

interface BarneyChatProps {
  messages: ChatMessage[];
  // Resolves `false` when the turn failed and the draft should be put back —
  // see the composer's `send` below. Returning void keeps the old
  // fire-and-forget behaviour for modes that have not opted in.
  onSend: (text: string) => void | Promise<boolean | void>;
  loading: boolean;
  // A turn is in flight. Separate from `loading` because `loading` is only the
  // typing indicator — it goes off on the first revealed character, while the
  // reveal keeps typing for a second or more afterwards. The composer stays
  // locked for the whole turn, so a send can never land mid-reveal and start a
  // second turn on top of one still being revealed (#491).
  busy?: boolean;
  disabled?: boolean;
  // Interview-only extras (Phase 1/2). When omitted — as in pitch/debrief — the
  // header is hidden and the input falls back to plain free text, so those modes
  // render exactly as before.
  section?: InterviewSection | null;
  progress?: InterviewProgress;
  input?: InputDescriptor;
  // Interview-only: when provided, renders a "Back" control in the header that
  // returns to the previous question so the user can change an answer (#chat-flow).
  onBack?: () => void;
  // The language the interview is being conducted in (ADR-0037). Drives the
  // surface's own copy and its text direction. Defaults to English: the modes
  // that pass none are pitch and debrief, which are not part of the interview
  // language choice.
  language?: InterviewLanguage;
  // When provided, the header renders the EN/HE flag toggle. Omitted by
  // pitch/debrief, which are not part of the interview language choice.
  onLanguageChange?: (language: InterviewLanguage) => void;
  // Who the Hebrew copy addresses (אתה/את/אתם), from the registered gender —
  // the same form Barney's own lines use. Defaults to the neutral plural.
  address?: AddressForm;
}

/**
 * Reusable chat surface used across all Barney modes (Phase 1, Phase 2, pitch,
 * debrief). Stateless about the conversation itself — the parent owns messages
 * and the send handler; this component only manages the draft input and, for
 * interviews, renders a progress header + interactive input controls driven by
 * the input descriptor the engine sends back each turn.
 */
export default function BarneyChat({
  messages,
  onSend,
  loading,
  busy,
  disabled,
  section,
  progress,
  input,
  onBack,
  // The interview screens always pass an explicit language, read from storage
  // before the session is opened. This default is for the surfaces that are NOT
  // part of the interview language choice — pitch and debrief, which stay
  // English (ADR-0037) — so it is deliberately English rather than the server's
  // Hebrew default for interviews.
  language = "en",
  onLanguageChange,
  address = "plural",
}: BarneyChatProps) {
  const strings = chatStrings(language, address);
  const rtl = isRtl(language);
  const [draft, setDraft] = useState("");
  // Toggled options for a "multiChoice" question (#529). Held here rather than
  // in the parent because it is composer state, not conversation state — it
  // never survives the turn it belongs to.
  const [selected, setSelected] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Whether the list should follow new content (#530). A ref so the effect
  // below reads the current value without re-subscribing; `pinned` mirrors it
  // for the jump-to-latest button, which needs a re-render.
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  // Content height as of the last follow decision, so the next one can tell how
  // much of the reader's distance from the bottom is just the new content.
  const previousContentLengthRef = useRef(0);
  // Set when the reader does something that means "take me back to the
  // conversation" — answering. Consumed by the next follow decision, which
  // otherwise only reads geometry and would leave them where they were.
  const forceFollowRef = useRef(false);

  function setPinnedBoth(next: boolean) {
    pinnedRef.current = next;
    setPinned((current) => (current === next ? current : next));
  }

  function scrollToLatest(behavior: ScrollBehavior = "smooth") {
    setPinnedBoth(true);
    bottomRef.current?.scrollIntoView({ behavior });
  }

  // Keep the latest message in view as the conversation grows or a reply lands
  // — but only while the reader is at the bottom. Scrolling up to re-read an
  // earlier question used to be undone by the next message (#530).
  //
  // The decision reads the scroller's live geometry rather than the pinned
  // state the scroll handler maintains. Scroll events are delivered
  // asynchronously, so between the reader dragging the list and React running
  // the handler there is a window in which a typewriter tick would still see
  // "pinned" and scroll — which is exactly the yank this issue is about, and it
  // reproduced about two runs in three. Live geometry cannot be stale.
  //
  // Instant, not smooth: a smooth scroll keeps animating after the reader grabs
  // the scroller, so a follow started a tick earlier would drag them down even
  // once the guard stops starting new ones. Only the deliberate jump-to-latest
  // press animates, where the movement is what the reader asked for.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const following =
      forceFollowRef.current ||
      shouldFollowNewContent(
        {
          offset: el.scrollTop,
          viewportLength: el.clientHeight,
          contentLength: el.scrollHeight,
        },
        previousContentLengthRef.current
      );
    previousContentLengthRef.current = el.scrollHeight;
    if (following) {
      forceFollowRef.current = false;
      setPinnedBoth(true);
      bottomRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [messages, loading]);

  const inputDisabled = loading || busy || disabled;
  const control: InputDescriptor = input ?? { kind: "text" };

  // Identity of the question currently being answered. A probe re-asks the same
  // node without advancing `answered`, so the selection survives a probe (the
  // user should not have to re-tick what they already chose) but is cleared the
  // moment a new field is asked — including when finalize() re-asks this one.
  const questionKey = `${control.kind}:${progress?.answered ?? 0}`;
  const [selectionKey, setSelectionKey] = useState(questionKey);
  if (selectionKey !== questionKey) {
    setSelectionKey(questionKey);
    setSelected([]);
  }

  function toggleOption(value: string) {
    setSelected((current) =>
      current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
    );
  }

  // Submits a multi-select: the ticked options plus whatever is in the composer,
  // as one comma-joined list. The free-text entry is merged into the selection
  // rather than replacing it, so "the three I ticked, and also woodworking"
  // arrives as a single answer the engine extracts in one pass.
  async function sendSelection() {
    if (inputDisabled) return;
    const typed = draft.trim();
    const chosen = selected;
    const parts = [...chosen, ...(typed ? [typed] : [])];
    if (parts.length === 0) return;
    setDraft("");
    setSelected([]);
    const accepted = await onSend(parts.join(", "));
    // A rejected turn must hand the whole answer back, ticks included — not
    // just the typed half (#510).
    if (accepted === false) {
      setDraft(typed);
      setSelected(chosen);
    }
  }

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || inputDisabled) return;
    // Answering is a deliberate return to the conversation, so re-follow it
    // even if they had scrolled up to check an earlier answer first (#530).
    forceFollowRef.current = true;
    setPinnedBoth(true);
    void onSend(trimmed);
  }

  // The free-text path. Clears optimistically, then puts the draft back if the
  // turn reports failure (#510). The composer emptying is what makes sending
  // feel like it worked, so that half stays immediate; what changes is that a
  // network drop, a 500 or an expired session no longer swallows an answer
  // someone spent real effort on. Only an explicit `false` restores, so a
  // handler returning void (pitch, debrief) behaves exactly as it did before.
  //
  // Deliberately separate from `send` above: the age picker and choice chips
  // submit a value the composer never held, and restoring one into the draft
  // would leave a stale "29" sitting in the text box on the next question.
  async function sendDraft() {
    // On a multi-select the composer is the "other" field, not a separate
    // answer — pressing Enter or the arrow must submit the ticked options too.
    if (control.kind === "multiChoice") return sendSelection();
    const trimmed = draft.trim();
    if (!trimmed || inputDisabled) return;
    setDraft("");
    forceFollowRef.current = true;
    setPinnedBoth(true);
    const accepted = await onSend(trimmed);
    if (accepted === false) setDraft(trimmed);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      void sendDraft();
    }
  }

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.answered / progress.total) * 100))
      : 0;

  return (
    // `dir` is the whole RTL story on web: the browser mirrors text alignment,
    // flex order and scrollbar side from it, so the layout below stays written
    // in logical terms rather than being duplicated per direction (ADR-0037).
    <div
      // Stable hook for the #531 E2E, which asserts the surface's own text
      // direction rather than the document's.
      data-testid="chat-surface"
      dir={rtl ? "rtl" : "ltr"}
      className="flex h-full flex-col"
    >
      {progress && (
        <div className="border-b border-border px-4 py-3 sm:px-6">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              {onBack && (
                <button
                  type="button"
                  onClick={onBack}
                  disabled={inputDisabled}
                  aria-label={strings.backAccessibility}
                  className={cn(
                    "flex items-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-30",
                    rtl ? "-mr-1" : "-ml-1"
                  )}
                >
                  {/* The chevron points back, which is the other way round in a
                      right-to-left layout. */}
                  <ChevronLeft className={cn("h-4 w-4", rtl && "rotate-180")} />
                  <span className="text-xs font-medium">{strings.back}</span>
                </button>
              )}
              <span className="text-sm font-medium text-foreground">
                {section ? section.title : strings.defaultSectionTitle}
              </span>
            </div>
            {onLanguageChange && (
              <LanguageToggle
                language={language}
                onChange={onLanguageChange}
                disabled={inputDisabled}
              />
            )}
            {progress && (
              <span
                // "9 / 18" is a bidi-neutral run: inside an RTL container the
                // browser reorders it to "18 / 9". Pinning this one span to LTR
                // keeps the counter reading the way a number does.
                dir="ltr"
                className="font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground"
              >
                {Math.min(progress.answered + 1, progress.total)} / {progress.total}
              </span>
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
            <div
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-full rounded-full bg-brand transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      <div className="relative flex-1 overflow-hidden">
        <div
          ref={listRef}
          // Stable hook for the #530 E2E, which has to drive this exact
          // scroller — selecting on the Tailwind classes would go quietly null
          // on a restyle.
          data-testid="chat-scroll"
          onScroll={(event) => {
            const el = event.currentTarget;
            setPinnedBoth(
              isAtBottom({
                offset: el.scrollTop,
                viewportLength: el.clientHeight,
                contentLength: el.scrollHeight,
              })
            );
          }}
          className="h-full space-y-4 overflow-y-auto p-4"
        >
          {messages.map((message, index) => {
            if (message.role === "system") {
              return (
                <div
                  key={index}
                  role="status"
                  aria-live="polite"
                  className="flex justify-center py-1"
                >
                  <span className="text-xs italic text-muted-foreground">{message.content}</span>
                </div>
              );
            }
            const isUser = message.role === "user";
            return (
              <div
                key={index}
                className={cn("flex flex-col", isUser ? "items-end" : "items-start")}
              >
                {!isUser && (
                  <span className="mb-1 px-1 text-xs font-medium text-muted-foreground">
                    {strings.barneyName}
                  </span>
                )}
                <div
                  // Stable hook for the #491 E2E, which has to identify Barney's
                  // bubbles precisely enough to prove two replies never share
                  // one. Selecting on the Tailwind classes instead would go
                  // quietly null on a restyle.
                  data-testid={isUser ? "user-bubble" : "barney-bubble"}
                  className={cn(
                    "max-w-[82%] whitespace-pre-wrap px-[18px] py-[15px] text-[15px] leading-snug",
                    isUser
                      ? "rounded-[22px] rounded-tr-lg bg-primary text-primary-foreground"
                      : "rounded-[22px] rounded-tl-lg bg-accent text-foreground"
                  )}
                >
                  {message.content}
                </div>
              </div>
            );
          })}
          {loading && (
            <div className="flex flex-col items-start">
              <span className="mb-1 px-1 text-xs font-medium text-muted-foreground">
                {strings.barneyName}
              </span>
              <div
                role="status"
                aria-label={strings.barneyTyping}
                className="flex items-center gap-1 rounded-[22px] rounded-tl-lg bg-accent px-[18px] py-[15px]"
              >
                <span className="h-2 w-2 animate-bounce rounded-full bg-brand/70 [animation-delay:-0.3s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-brand/70 [animation-delay:-0.15s]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-brand/70" />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {!pinned && (
          <button
            type="button"
            onClick={() => scrollToLatest()}
            className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-xs font-semibold text-brand-foreground shadow-lg transition-colors duration-200 hover:bg-brand/90"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            {strings.jumpToLatest}
          </button>
        )}
      </div>

      <div className="border-t border-border p-4">
        {control.kind === "choice" && (
          <div className="mb-3 flex flex-wrap gap-2">
            {control.options.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => send(option.value)}
                disabled={inputDisabled}
                className="rounded-full border border-brand/40 bg-brand/10 px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-brand/20 disabled:pointer-events-none disabled:opacity-40"
              >
                {option.label}
              </button>
            ))}
          </div>
        )}

        {control.kind === "multiChoice" && (
          <div className="mb-3">
            <p className="mb-2 px-1 text-xs text-muted-foreground">
              {selected.length === 0
                ? strings.pickAsManyAsYouLike
                : strings.selectedCount(selected.length)}
            </p>
            <div className="flex flex-wrap gap-2">
              {control.options.map((option) => {
                const isSelected = selected.includes(option.value);
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => toggleOption(option.value)}
                    disabled={inputDisabled}
                    aria-pressed={isSelected}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-medium text-foreground transition-colors duration-200 ease-out disabled:pointer-events-none disabled:opacity-40",
                      isSelected
                        ? "border-brand bg-brand/20"
                        : "border-brand/40 bg-brand/10 hover:bg-brand/20"
                    )}
                  >
                    {isSelected && <Check className="h-3.5 w-3.5" />}
                    {option.label}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => void sendSelection()}
              disabled={inputDisabled || (selected.length === 0 && draft.trim().length === 0)}
              className="mt-3 w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-40"
            >
              {control.confirmLabel}
            </button>
          </div>
        )}

        {control.kind === "age" ? (
          <AgePicker
            min={control.min}
            max={control.max}
            disabled={inputDisabled}
            onConfirm={(age) => send(String(age))}
          />
        ) : control.kind === "height" ? (
          <HeightPicker
            minCm={control.minCm}
            maxCm={control.maxCm}
            disabled={inputDisabled}
            onConfirm={(label) => send(label)}
          />
        ) : (
          (control.kind === "text" || control.allowFreeText) && (
            <>
              <MessageLengthCounter length={draft.length} language={language} address={address} />
              <div className="flex items-center gap-2 rounded-[22px] border border-border px-4 py-2 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background">
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={inputDisabled}
                  maxLength={MAX_MESSAGE_LENGTH}
                  placeholder={
                    control.kind === "choice"
                      ? strings.orInYourOwnWords
                      : control.kind === "multiChoice"
                        ? strings.anythingElseAddItHere
                        : strings.typeYourMessage
                  }
                  aria-label={strings.messageInput}
                  className="flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => void sendDraft()}
                  disabled={inputDisabled || draft.trim().length === 0}
                  aria-label={strings.send}
                  className="text-foreground transition-opacity hover:opacity-70 disabled:pointer-events-none disabled:opacity-30"
                >
                  {/* The arrow means "send", i.e. forward — which is leftward
                      in a right-to-left layout. */}
                  <ArrowRight className={cn("h-5 w-5", rtl && "rotate-180")} />
                </button>
              </div>
            </>
          )
        )}
      </div>
    </div>
  );
}

/**
 * Live character count, shown only once the draft is near the cap.
 *
 * The composer enforces MAX_MESSAGE_LENGTH itself, so without this the field
 * would simply stop accepting characters — and a longer pasted answer would be
 * truncated — with nothing on screen saying why. Before #493 the bound was
 * enforced only server-side, and the user got "Something went wrong. Please try
 * again." with no mention of length and no way to recover their text.
 */
function MessageLengthCounter({
  length,
  language,
  address,
}: {
  length: number;
  language: InterviewLanguage;
  address: AddressForm;
}) {
  if (length < MESSAGE_LENGTH_COUNTER_FROM) return null;
  const atLimit = length >= MAX_MESSAGE_LENGTH;

  return (
    <div className="mb-2 flex justify-end">
      <span
        role="status"
        aria-live="polite"
        className={cn(
          "font-mono text-[11px] tabular-nums",
          atLimit ? "text-destructive" : "text-muted-foreground"
        )}
      >
        {length} / {MAX_MESSAGE_LENGTH}
        {atLimit && chatStrings(language, address).lengthLimitSuffix}
      </span>
    </div>
  );
}

// An 18+ age picker: a constrained dropdown so a value under the minimum can
// never be entered (the client-side half of the under-18 fix; the engine
// rejects it too). Defaults to a sensible mid-20s value.
function AgePicker({
  min,
  max,
  disabled,
  onConfirm,
}: {
  min: number;
  max: number;
  disabled?: boolean;
  onConfirm: (age: number) => void;
}) {
  // Cap the visible list so the dropdown stays usable; the engine still accepts
  // up to `max` for anyone who types it via a free-text turn elsewhere.
  const ceiling = Math.min(max, 99);
  const [age, setAge] = useState(Math.min(ceiling, 25));
  const ages: number[] = [];
  for (let a = min; a <= ceiling; a++) ages.push(a);

  return (
    <div className="flex items-center gap-2">
      <select
        value={age}
        disabled={disabled}
        onChange={(event) => setAge(Number(event.target.value))}
        aria-label="Your age"
        className="flex-1 rounded-[22px] border border-border bg-transparent px-4 py-2.5 text-[15px] text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
      >
        {ages.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onConfirm(age)}
        disabled={disabled}
        className="flex items-center gap-1 rounded-[22px] bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
      >
        Confirm
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}

// Renders a centimetre value with its imperial equivalent, e.g. 175 → 175 cm
// (5'9"). The label doubles as the value sent back, so the stored height is a
// readable string carrying both units.
function formatHeight(cm: number): string {
  const totalInches = Math.round(cm / 2.54);
  const feet = Math.floor(totalInches / 12);
  const inches = totalInches % 12;
  return `${cm} cm (${feet}'${inches}")`;
}

// A scrolling height picker: a constrained dropdown of heights so the answer is
// always a well-formed value and can never be off-topic free text (#228). Mirrors
// AgePicker. Defaults to a sensible middle-of-range height.
function HeightPicker({
  minCm,
  maxCm,
  disabled,
  onConfirm,
}: {
  minCm: number;
  maxCm: number;
  disabled?: boolean;
  onConfirm: (label: string) => void;
}) {
  const heights: number[] = [];
  for (let c = minCm; c <= maxCm; c++) heights.push(c);
  const [cm, setCm] = useState(Math.min(maxCm, Math.max(minCm, 172)));

  return (
    <div className="flex items-center gap-2">
      <select
        value={cm}
        disabled={disabled}
        onChange={(event) => setCm(Number(event.target.value))}
        aria-label="Your height"
        className="flex-1 rounded-[22px] border border-border bg-transparent px-4 py-2.5 text-[15px] text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
      >
        {heights.map((c) => (
          <option key={c} value={c}>
            {formatHeight(c)}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onConfirm(formatHeight(cm))}
        disabled={disabled}
        className="flex items-center gap-1 rounded-[22px] bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
      >
        Confirm
        <ArrowRight className="h-4 w-4" />
      </button>
    </div>
  );
}
