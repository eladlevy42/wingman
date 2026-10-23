import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  KeyboardAvoidingView,
  Pressable,
  Platform,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Picker } from "@react-native-picker/picker";
import { ArrowDown, ArrowRight, Check, ChevronLeft } from "lucide-react-native";
import type {
  AddressForm,
  ChatMessage,
  ChatUiStrings,
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
import LanguageToggle from "~/components/LanguageToggle";
import { Text } from "~/components/ui/text";
import { COLORS } from "~/lib/colors";
import { formatHeight } from "~/lib/formatHeight";
import { useKeyboardVisible } from "~/hooks/useKeyboardVisible";
import { cn } from "~/lib/utils";

interface BarneyChatProps {
  messages: ChatMessage[];
  // Resolves `false` when the turn failed and the draft should be put back —
  // see `sendDraft` below. Returning void keeps the old fire-and-forget
  // behaviour for any caller that has not opted in.
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
  // render exactly as they would without them.
  section?: InterviewSection | null;
  progress?: InterviewProgress;
  input?: InputDescriptor;
  // Interview-only: when provided, renders a "Back" control in the header that
  // returns to the previous question so the user can change an answer.
  onBack?: () => void;
  // The language the interview is being conducted in (ADR-0037). Drives this
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
 * Reusable chat surface for every Barney mode — the React Native counterpart of
 * apps/web/src/components/BarneyChat.tsx, and the template slices 2-5 build on.
 *
 * Stateless about the conversation itself: the parent (normally via
 * useBarneyChat) owns the messages and the send handler. This component manages
 * the draft, the interactive input control the engine asks for each turn, and
 * the two things that make a chat usable on a phone — the composer staying above
 * the keyboard, and the list staying pinned to the newest message.
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
  // Yoga's per-subtree `direction`, not I18nManager: I18nManager.forceRTL flips
  // the whole app and only takes effect after a reload, which a toggle sitting
  // inside the conversation cannot do. Setting `direction` on this root mirrors
  // row layout and text alignment for everything below it, immediately, and
  // leaves the rest of the app alone (ADR-0037).
  const directionStyle = { direction: rtl ? ("rtl" as const) : ("ltr" as const) };
  const [draft, setDraft] = useState("");
  // Toggled options for a "multiChoice" question (#529). Composer state, not
  // conversation state — it never survives the turn it belongs to.
  const [selected, setSelected] = useState<string[]>([]);
  const scrollRef = useRef<ScrollView>(null);
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();

  // Whether the list should follow new content (#530). A ref, not state,
  // because onContentSizeChange fires on every typewriter tick and must read
  // the latest value without waiting for a re-render. `pinned` mirrors it for
  // the jump-to-latest button, which does need to re-render.
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  // The scroller's geometry as of the last scroll event, plus the content
  // height at the last follow decision. onContentSizeChange hands us the new
  // height but not where the reader is, so the offset/viewport come from here.
  const metricsRef = useRef({ offset: 0, viewportLength: 0 });
  const previousContentLengthRef = useRef(0);
  // Set when the reader answers — a deliberate "take me back to the
  // conversation", which geometry alone would not infer.
  const forceFollowRef = useRef(false);

  function setPinnedBoth(next: boolean) {
    pinnedRef.current = next;
    setPinned((current) => (current === next ? current : next));
  }

  function scrollToLatest(animated = true) {
    forceFollowRef.current = false;
    setPinnedBoth(true);
    scrollRef.current?.scrollToEnd({ animated });
  }

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
    forceFollowRef.current = true;
    setPinnedBoth(true);
    scrollRef.current?.scrollToEnd({ animated: true });
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
    // The immediate scroll covers the case where the content does not grow
    // right away (the bubble renders a frame later): the reader lands on the
    // newest message the moment they send, not when the reply arrives.
    forceFollowRef.current = true;
    setPinnedBoth(true);
    scrollRef.current?.scrollToEnd({ animated: true });
    void onSend(trimmed);
  }

  // The free-text path. Clears optimistically, then puts the draft back if the
  // turn reports failure (#510). The composer emptying is what makes sending
  // feel like it worked, so that half stays immediate; what changes is that a
  // network drop, a 500 or an expired session no longer swallows an answer
  // someone spent real effort on. Only an explicit `false` restores.
  //
  // Deliberately separate from `send` above: the age picker and choice chips
  // submit a value the composer never held, and restoring one into the draft
  // would leave a stale "29" sitting in the text box on the next question.
  async function sendDraft() {
    // On a multi-select the composer is the "other" field, not a separate
    // answer — the send arrow must submit the ticked options too.
    if (control.kind === "multiChoice") return sendSelection();
    const trimmed = draft.trim();
    if (!trimmed || inputDisabled) return;
    setDraft("");
    forceFollowRef.current = true;
    setPinnedBoth(true);
    scrollRef.current?.scrollToEnd({ animated: true });
    const accepted = await onSend(trimmed);
    if (accepted === false) setDraft(trimmed);
  }

  return (
    <KeyboardAvoidingView
      className="flex-1"
      style={directionStyle}
      // "padding" on both platforms. Android used to resize its own window for
      // the keyboard (adjustResize), which would have made this double-count
      // there — but Expo SDK 54 enables edge-to-edge, the window no longer
      // resizes, and without this the keyboard sits straight on top of the
      // composer.
      behavior="padding"
    >
      {progress && (
        <View className="border-border border-b px-4 py-3">
          <View className="mb-2 flex-row items-center justify-between">
            <View className="flex-row items-center gap-1.5">
              {onBack && (
                <Pressable
                  onPress={onBack}
                  disabled={inputDisabled}
                  accessibilityRole="button"
                  accessibilityLabel={strings.backAccessibility}
                  className={cn(
                    "flex-row items-center",
                    rtl ? "-mr-1" : "-ml-1",
                    inputDisabled && "opacity-30"
                  )}
                >
                  {/* The chevron points back, which is the other way round in a
                      right-to-left layout. */}
                  <ChevronLeft
                    size={16}
                    color={COLORS.mutedForeground}
                    style={rtl ? { transform: [{ scaleX: -1 }] } : undefined}
                  />
                  <Text className="text-muted-foreground text-xs font-medium">{strings.back}</Text>
                </Pressable>
              )}
              <Text className="text-foreground text-sm font-medium">
                {section ? section.title : strings.defaultSectionTitle}
              </Text>
              {onLanguageChange && (
                <LanguageToggle
                  language={language}
                  onChange={onLanguageChange}
                  disabled={inputDisabled}
                />
              )}
            </View>
            <Text
              // "9 / 18" is a bidi-neutral run, which an RTL container reorders
              // to "18 / 9". Pin this one label to LTR so the counter reads the
              // way a number does.
              style={{ writingDirection: "ltr" }}
              className="text-muted-foreground text-[11px] uppercase tracking-[1.3px]"
            >
              {Math.min(progress.answered + 1, progress.total)} / {progress.total}
            </Text>
          </View>
          <ProgressBar answered={progress.answered} total={progress.total} />
        </View>
      )}

      <View className="flex-1">
        <ScrollView
          ref={scrollRef}
          // Stable hook for the #530 component tests, which drive this
          // scroller's scroll and content-size events directly.
          testID="chat-scroll"
          className="flex-1"
          contentContainerClassName="gap-4 p-4"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          // The viewport height has to be known before the first follow
          // decision, and onScroll only fires once the reader actually
          // scrolls — someone who never touches the list would otherwise be
          // measured against a zero-height window and stop being followed.
          onLayout={(event) => {
            metricsRef.current = {
              ...metricsRef.current,
              viewportLength: event.nativeEvent.layout.height,
            };
          }}
          // Every scroll re-decides whether the reader is following along. The
          // throttle is per-frame rather than the RN default (0, i.e. once per
          // gesture) so releasing a flick mid-list still settles on the right
          // answer.
          scrollEventThrottle={16}
          onScroll={(event) => {
            const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
            metricsRef.current = {
              offset: contentOffset.y,
              viewportLength: layoutMeasurement.height,
            };
            setPinnedBoth(
              isAtBottom({
                offset: contentOffset.y,
                viewportLength: layoutMeasurement.height,
                contentLength: contentSize.height,
              })
            );
          }}
          // Fires on every content height change — a new bubble, and every
          // typewriter tick that grows the current one. Following it is only
          // right while the reader is at the bottom; if they have scrolled up to
          // re-read something, moving them is the bug this guard fixes (#530).
          // Unanimated for the same reason as web: an animated follow-scroll
          // keeps running after the reader grabs the list, dragging them back
          // down even once the guard has stopped starting new ones. The
          // deliberate jump-to-latest press animates; following does not.
          //
          // The decision subtracts the growth this callback is reporting, so a
          // reader who was following is not judged "adrift" by exactly the
          // height of the bubble that just arrived. Shares the predicate with
          // web (packages/shared) so the two clients cannot drift apart.
          onContentSizeChange={(_width, height) => {
            const following =
              forceFollowRef.current ||
              shouldFollowNewContent(
                { ...metricsRef.current, contentLength: height },
                previousContentLengthRef.current
              );
            previousContentLengthRef.current = height;
            if (following) {
              forceFollowRef.current = false;
              setPinnedBoth(true);
              scrollRef.current?.scrollToEnd({ animated: false });
            }
          }}
        >
          {messages.map((message, index) => (
            <MessageRow key={index} message={message} rtl={rtl} strings={strings} />
          ))}
          {loading && <TypingIndicator strings={strings} />}
        </ScrollView>

        {!pinned && (
          <Pressable
            onPress={() => scrollToLatest()}
            accessibilityRole="button"
            accessibilityLabel={strings.jumpToLatest}
            className="bg-brand absolute bottom-3 self-center flex-row items-center gap-1.5 rounded-full px-4 py-2"
          >
            <ArrowDown size={14} color={COLORS.brandForeground} />
            <Text className="text-brand-foreground text-xs font-semibold">
              {strings.jumpToLatest}
            </Text>
          </Pressable>
        )}
      </View>

      <View
        className="border-border border-t p-4"
        // See useKeyboardVisible: the keyboard and the home-indicator inset must
        // never both pad the composer.
        style={{ paddingBottom: keyboardVisible ? 16 : insets.bottom + 16 }}
      >
        {control.kind === "choice" && (
          <View className="mb-3 flex-row flex-wrap gap-2">
            {control.options.map((option) => (
              <Pressable
                key={option.value}
                onPress={() => send(option.value)}
                disabled={inputDisabled}
                accessibilityRole="button"
                className={cn(
                  "border-brand/40 bg-brand/10 active:bg-brand/20 rounded-full border px-4 py-2",
                  inputDisabled && "opacity-40"
                )}
              >
                <Text className="text-foreground text-sm font-medium">{option.label}</Text>
              </Pressable>
            ))}
          </View>
        )}

        {control.kind === "multiChoice" && (
          <View className="mb-3">
            <Text className="text-muted-foreground mb-2 px-1 text-xs">
              {selected.length === 0
                ? strings.pickAsManyAsYouLike
                : strings.selectedCount(selected.length)}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {control.options.map((option) => {
                const isSelected = selected.includes(option.value);
                return (
                  <Pressable
                    key={option.value}
                    onPress={() => toggleOption(option.value)}
                    disabled={inputDisabled}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: isSelected }}
                    accessibilityLabel={option.label}
                    className={cn(
                      "flex-row items-center gap-1.5 rounded-full border px-4 py-2",
                      isSelected ? "border-brand bg-brand/20" : "border-brand/40 bg-brand/10",
                      inputDisabled && "opacity-40"
                    )}
                  >
                    {isSelected && <Check size={14} color={COLORS.foreground} />}
                    <Text className="text-foreground text-sm font-medium">{option.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Pressable
              onPress={() => void sendSelection()}
              disabled={inputDisabled || (selected.length === 0 && draft.trim().length === 0)}
              accessibilityRole="button"
              accessibilityLabel={control.confirmLabel}
              className={cn(
                "bg-primary active:bg-primary/90 mt-3 rounded-lg px-4 py-2.5",
                (inputDisabled || (selected.length === 0 && draft.trim().length === 0)) &&
                  "opacity-40"
              )}
            >
              <Text className="text-primary-foreground text-center text-sm font-medium">
                {control.confirmLabel}
              </Text>
            </Pressable>
          </View>
        )}

        {control.kind === "age" ? (
          <ValuePicker
            // The picker holds its selection internally, so it must remount
            // whenever a *new question* is asked — otherwise the previous
            // answer carries over. Kind alone is not enough: Phase 2 asks
            // ageMin and ageMax back to back, and both are kind "age", so the
            // max picker would open on whatever was chosen for min. Pairing it
            // with the answered count gives one identity per collected field,
            // while leaving a probe on the same field (which does not advance
            // the count) free to keep the selection.
            key={`age:${progress?.answered ?? 0}`}
            accessibilityLabel={strings.yourAge}
            values={rangeValues(control.min, Math.min(control.max, 99))}
            initial={Math.min(Math.min(control.max, 99), 25)}
            format={String}
            disabled={inputDisabled}
            onConfirm={send}
          />
        ) : control.kind === "height" ? (
          <ValuePicker
            key={`height:${progress?.answered ?? 0}`}
            accessibilityLabel={strings.yourHeight}
            values={rangeValues(control.minCm, control.maxCm)}
            initial={Math.min(control.maxCm, Math.max(control.minCm, 172))}
            format={formatHeight}
            disabled={inputDisabled}
            onConfirm={send}
          />
        ) : (
          (control.kind === "text" || control.allowFreeText) && (
            <>
              <MessageLengthCounter length={draft.length} language={language} address={address} />
              {/* Dimmed as a whole when the composer is closed. The send arrow
                  already faded on its own, but the field did not, so a closed
                  composer looked exactly like an open one — fine while the only
                  caller was the interview (which navigates away the moment it
                  sets `disabled`), misleading for the pitch, where the composer
                  stays on screen after the third question is spent (#463). */}
              <View
                className={cn(
                  "border-border flex-row items-center gap-2 rounded-[22px] border px-4 py-1",
                  inputDisabled && "opacity-50"
                )}
              >
                <TextInput
                  value={draft}
                  onChangeText={setDraft}
                  onSubmitEditing={() => void sendDraft()}
                  editable={!inputDisabled}
                  maxLength={MAX_MESSAGE_LENGTH}
                  // A multiline input defaults to submitBehavior "newline", so
                  // the return key inserted a line break and onSubmitEditing
                  // never fired — pressing send on the keyboard did nothing
                  // (#530). "submit" fires the submit event without blurring,
                  // which also supersedes the deprecated blurOnSubmit={false}
                  // that was here for the same keep-the-keyboard-open reason.
                  // multiline stays: long answers still wrap and scroll.
                  submitBehavior="submit"
                  returnKeyType="send"
                  multiline
                  accessibilityLabel={strings.messageInput}
                  placeholder={
                    control.kind === "choice"
                      ? strings.orInYourOwnWords
                      : control.kind === "multiChoice"
                        ? strings.anythingElseAddItHere
                        : strings.typeYourMessage
                  }
                  placeholderTextColor={COLORS.mutedForeground}
                  // RN does not derive a TextInput's own writing direction from
                  // the yoga `direction` above, so the caret and placeholder
                  // would sit on the wrong side without this.
                  style={{ writingDirection: rtl ? "rtl" : "ltr" }}
                  className="text-foreground max-h-28 flex-1 py-2.5 text-[15px]"
                />
                <Pressable
                  onPress={() => void sendDraft()}
                  disabled={inputDisabled || draft.trim().length === 0}
                  accessibilityRole="button"
                  accessibilityLabel={strings.send}
                  className={cn(
                    "p-1",
                    (inputDisabled || draft.trim().length === 0) && "opacity-30"
                  )}
                >
                  {/* The arrow means "send", i.e. forward — leftward in RTL. */}
                  <ArrowRight
                    size={20}
                    color={COLORS.foreground}
                    style={rtl ? { transform: [{ scaleX: -1 }] } : undefined}
                  />
                </Pressable>
              </View>
            </>
          )
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

/**
 * Live character count, shown only once the draft is near the cap. The React
 * Native counterpart of the same component in apps/web/src/components/BarneyChat.tsx.
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
  const strings = chatStrings(language, address);
  const atLimit = length >= MAX_MESSAGE_LENGTH;
  const announcedAtLimit = useRef(false);

  // `accessibilityLiveRegion` is Android-only in React Native, and ADR-0033
  // pins iOS testing to Expo Go — so on the platform we actually test, nothing
  // announces the counter. VoiceOver needs an explicit announcement.
  //
  // Only the limit crossing is announced, not every keystroke: a live region
  // that fires on each character turns typing into a stream of interruptions.
  // The ref makes it edge-triggered, so backing off the limit and hitting it
  // again announces once more.
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    if (atLimit && !announcedAtLimit.current) {
      announcedAtLimit.current = true;
      AccessibilityInfo.announceForAccessibility(
        strings.lengthLimitAnnouncement(MAX_MESSAGE_LENGTH)
      );
    } else if (!atLimit) {
      announcedAtLimit.current = false;
    }
  }, [atLimit, strings]);

  if (length < MESSAGE_LENGTH_COUNTER_FROM) return null;

  return (
    <View className="mb-2 items-end" accessibilityLiveRegion="polite">
      <Text
        // Mirrors the web counter's `tabular-nums`: without fixed-width digits
        // the count reflows as it climbs. NativeWind has no utility for this,
        // so it goes through the RN prop.
        style={{ fontVariant: ["tabular-nums"] }}
        className={cn("text-[11px]", atLimit ? "text-destructive" : "text-muted-foreground")}
      >
        {length} / {MAX_MESSAGE_LENGTH}
        {atLimit && strings.lengthLimitSuffix}
      </Text>
    </View>
  );
}

function rangeValues(from: number, to: number): number[] {
  const values: number[] = [];
  for (let value = from; value <= to; value++) values.push(value);
  return values;
}

function MessageRow({
  message,
  rtl,
  strings,
}: {
  message: ChatMessage;
  rtl: boolean;
  strings: ChatUiStrings;
}) {
  if (message.role === "system") {
    return (
      <View className="items-center py-1" accessibilityRole="text" accessibilityLiveRegion="polite">
        {/* No italic in RTL: the system font has no true Hebrew italic, so the
            synthetic slant makes the letters look broken. */}
        <Text className={cn("text-muted-foreground text-xs", !rtl && "italic")}>
          {message.content}
        </Text>
      </View>
    );
  }

  const isUser = message.role === "user";
  return (
    <View className={isUser ? "items-end" : "items-start"}>
      {!isUser && (
        <Text className="text-muted-foreground mb-1 px-1 text-xs font-medium">
          {strings.barneyName}
        </Text>
      )}
      <View
        className={cn(
          "max-w-[82%] rounded-[22px] px-[18px] py-[15px]",
          isUser ? "bg-primary rounded-tr-lg" : "bg-accent rounded-tl-lg"
        )}
      >
        <Text
          className={cn(
            // Hebrew glyphs sit lower and denser than Latin at the same size, so
            // RTL text gets one extra point of size and taller lines to breathe.
            rtl ? "text-[16px] leading-[24px]" : "text-[15px] leading-[21px]",
            isUser ? "text-primary-foreground" : "text-foreground"
          )}
        >
          {message.content}
        </Text>
      </View>
    </View>
  );
}

// Three dots rising in sequence while Barney composes a reply. Written with the
// RN Animated API rather than the web's `animate-bounce` utility, which
// NativeWind does not implement — CSS keyframe animations have no native
// equivalent.
function TypingIndicator({ strings }: { strings: ChatUiStrings }) {
  // One Animated.Value per dot, created once. useState with a lazy initialiser
  // rather than useRef: these values are read while rendering (each dot's
  // transform), and a ref must not be. The setter is never called, so this is
  // "state" only in the sense of surviving re-render — of which there are many,
  // since the parent re-renders on every typewriter tick.
  const [dots] = useState(() => [
    new Animated.Value(0),
    new Animated.Value(0),
    new Animated.Value(0),
  ]);

  useEffect(() => {
    const animations = dots.map((dot, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 150),
          Animated.timing(dot, { toValue: -4, duration: 250, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0, duration: 250, useNativeDriver: true }),
          Animated.delay((2 - index) * 150),
        ])
      )
    );
    animations.forEach((animation) => animation.start());
    return () => animations.forEach((animation) => animation.stop());
    // `dots` holds three refs, stable for this component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View className="items-start">
      <Text className="text-muted-foreground mb-1 px-1 text-xs font-medium">
        {strings.barneyName}
      </Text>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={strings.barneyTyping}
        className="bg-accent flex-row items-center gap-1 rounded-[22px] rounded-tl-lg px-[18px] py-[15px]"
      >
        {dots.map((dot, index) => (
          <Animated.View
            key={index}
            style={{ transform: [{ translateY: dot }] }}
            className="bg-brand/70 h-2 w-2 rounded-full"
          />
        ))}
      </View>
    </View>
  );
}

function ProgressBar({ answered, total }: { answered: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((answered / total) * 100)) : 0;
  // Seeded with the first percentage so the bar does not animate up from zero
  // when the screen mounts mid-interview. Held in state, not a ref, because it
  // is read during render (see the interpolate below).
  const [width] = useState(() => new Animated.Value(pct));

  useEffect(() => {
    Animated.timing(width, {
      toValue: pct,
      duration: 500,
      // Width is a layout property, so this one cannot run on the UI thread.
      useNativeDriver: false,
    }).start();
  }, [pct, width]);

  return (
    <View
      className="bg-secondary h-1.5 w-full overflow-hidden rounded-full"
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: pct }}
    >
      <Animated.View
        className="bg-brand h-full rounded-full"
        style={{ width: width.interpolate({ inputRange: [0, 100], outputRange: ["0%", "100%"] }) }}
      />
    </View>
  );
}

/**
 * A constrained picker with a Confirm button, shared by the age and height
 * inputs. Both exist for the same reason: the answer must be a well-formed
 * value, so the user picks from a range instead of typing free text that the
 * engine would then have to interpret (an age under the minimum, for instance,
 * cannot be entered at all).
 *
 * The web client uses a <select> for each; on native that is @react-native-picker,
 * which renders as the iOS wheel — so unlike the web version the value is always
 * visible, and Confirm is what commits it.
 */
function ValuePicker({
  values,
  initial,
  format,
  disabled,
  accessibilityLabel,
  onConfirm,
}: {
  values: number[];
  initial: number;
  format: (value: number) => string;
  disabled?: boolean;
  accessibilityLabel: string;
  onConfirm: (label: string) => void;
}) {
  const [value, setValue] = useState(initial);

  return (
    <View className="gap-2">
      <View className="border-border overflow-hidden rounded-[22px] border">
        <Picker
          selectedValue={value}
          enabled={!disabled}
          onValueChange={(next) => setValue(Number(next))}
          accessibilityLabel={accessibilityLabel}
          itemStyle={{ fontSize: 18, height: 120 }}
        >
          {values.map((candidate) => (
            <Picker.Item key={candidate} label={format(candidate)} value={candidate} />
          ))}
        </Picker>
      </View>
      <Pressable
        onPress={() => onConfirm(format(value))}
        disabled={disabled}
        accessibilityRole="button"
        className={cn(
          "bg-primary active:bg-primary/90 flex-row items-center justify-center gap-1 rounded-[22px] px-5 py-3",
          disabled && "opacity-40"
        )}
      >
        <Text className="text-primary-foreground text-sm font-semibold">Confirm</Text>
        <ArrowRight size={16} color={COLORS.primaryForeground} />
      </Pressable>
    </View>
  );
}
