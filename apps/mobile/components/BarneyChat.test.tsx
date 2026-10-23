import { render, screen, fireEvent, act } from "@testing-library/react-native";
import { MAX_MESSAGE_LENGTH, MESSAGE_LENGTH_COUNTER_FROM } from "@wingman/shared";
import type { ChatMessage } from "@wingman/shared";
import BarneyChat from "~/components/BarneyChat";

// The composer reads the home-indicator inset directly. Outside a
// SafeAreaProvider that hook has no value to return, and this is layout the
// tests below never assert on.
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const MESSAGES: ChatMessage[] = [
  { role: "assistant", content: "So what actually gets you out of bed?" },
];

function renderChat(overrides: Partial<React.ComponentProps<typeof BarneyChat>> = {}) {
  const onSend = jest.fn();
  const utils = render(
    // These assertions read the surface's English copy, so they opt into
    // English explicitly now that Hebrew is the default (ADR-0037). The Hebrew
    // rendering and the toggle have their own describe at the bottom.
    <BarneyChat messages={MESSAGES} onSend={onSend} loading={false} language="en" {...overrides} />
  );
  return { ...utils, onSend };
}

const input = () => screen.getByLabelText("Message input");

describe("BarneyChat composer", () => {
  it("renders the conversation", () => {
    renderChat();
    expect(screen.getByText("So what actually gets you out of bed?")).toBeOnTheScreen();
    expect(screen.getByText("Barney")).toBeOnTheScreen();
  });

  it("sends a trimmed draft and clears the composer", async () => {
    const { onSend } = renderChat();

    fireEvent.changeText(input(), "  climbing, mostly  ");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Send"));
    });

    expect(onSend).toHaveBeenCalledWith("climbing, mostly");
    expect(input().props.value).toBe("");
  });

  it("ignores a whitespace-only draft", async () => {
    const { onSend } = renderChat();

    fireEvent.changeText(input(), "   ");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Send"));
    });

    expect(onSend).not.toHaveBeenCalled();
  });

  // #510: the composer clears optimistically, but a turn that reports failure
  // has to hand the text back. Losing an answer someone spent real effort on is
  // the whole bug.
  it("restores the draft when the turn reports failure", async () => {
    const onSend = jest.fn().mockResolvedValue(false);
    render(<BarneyChat messages={MESSAGES} onSend={onSend} loading={false} language="en" />);

    fireEvent.changeText(input(), "a long, considered answer");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Send"));
    });

    expect(input().props.value).toBe("a long, considered answer");
  });

  it("keeps the composer clear when the turn succeeds", async () => {
    const onSend = jest.fn().mockResolvedValue(true);
    render(<BarneyChat messages={MESSAGES} onSend={onSend} loading={false} language="en" />);

    fireEvent.changeText(input(), "an accepted answer");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Send"));
    });

    expect(input().props.value).toBe("");
  });

  // #491: `busy` covers the whole turn, including the reveal that keeps typing
  // after the typing indicator goes off. A send landing mid-reveal starts a
  // second turn on top of one still being revealed.
  it("refuses to send while a turn is still in flight", async () => {
    const { onSend } = renderChat({ busy: true });

    fireEvent.changeText(input(), "impatient second answer");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Send"));
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(input().props.editable).toBe(false);
  });
});

// #493: before this, the 4000-character bound was enforced only server-side and
// a longer answer came back as "Something went wrong. Please try again." with no
// mention of length. The counter is the on-screen explanation for a field that
// would otherwise just stop accepting characters.
describe("BarneyChat message length counter", () => {
  it("caps the input at the shared maximum", () => {
    renderChat();
    expect(input().props.maxLength).toBe(MAX_MESSAGE_LENGTH);
  });

  it("stays hidden until the draft approaches the limit", () => {
    renderChat();

    fireEvent.changeText(input(), "a".repeat(MESSAGE_LENGTH_COUNTER_FROM - 1));
    expect(screen.queryByText(new RegExp(`/ ${MAX_MESSAGE_LENGTH}`))).not.toBeOnTheScreen();
  });

  it("appears at the shared threshold and counts up", () => {
    renderChat();

    fireEvent.changeText(input(), "a".repeat(MESSAGE_LENGTH_COUNTER_FROM));
    expect(
      screen.getByText(`${MESSAGE_LENGTH_COUNTER_FROM} / ${MAX_MESSAGE_LENGTH}`)
    ).toBeOnTheScreen();
  });

  it("says why typing stopped once the draft is at the limit", () => {
    renderChat();

    fireEvent.changeText(input(), "a".repeat(MAX_MESSAGE_LENGTH));
    expect(
      screen.getByText(
        `${MAX_MESSAGE_LENGTH} / ${MAX_MESSAGE_LENGTH} — that's the limit, keep it shorter`
      )
    ).toBeOnTheScreen();
  });
});

// #529: the hobbies question is a multi-select because free-text hobbies were
// being extracted into a malformed shape and silently dropped. What matters
// here is that every tapped option reaches onSend in one message, together with
// anything typed into the "other" field.
describe("BarneyChat multi-select", () => {
  const MULTI = {
    kind: "multiChoice" as const,
    allowFreeText: true,
    confirmLabel: "Done",
    options: [
      { label: "Cooking", value: "cooking" },
      { label: "Hiking", value: "hiking" },
      { label: "Gaming", value: "gaming" },
    ],
  };

  function renderMulti(overrides: Partial<React.ComponentProps<typeof BarneyChat>> = {}) {
    const onSend = jest.fn();
    const utils = render(
      <BarneyChat
        messages={MESSAGES}
        onSend={onSend}
        loading={false}
        input={MULTI}
        progress={{ answered: 3, total: 10 }}
        language="en"
        {...overrides}
      />
    );
    return { ...utils, onSend };
  }

  const confirm = () => screen.getByLabelText("Done");

  it("renders every option and the confirm control", () => {
    renderMulti();
    expect(screen.getByLabelText("Cooking")).toBeOnTheScreen();
    expect(screen.getByLabelText("Hiking")).toBeOnTheScreen();
    expect(screen.getByLabelText("Gaming")).toBeOnTheScreen();
    expect(confirm()).toBeOnTheScreen();
    expect(screen.getByText("Pick as many as you like")).toBeOnTheScreen();
  });

  it("sends every selected option as one comma-joined answer", async () => {
    const { onSend } = renderMulti();

    fireEvent.press(screen.getByLabelText("Cooking"));
    fireEvent.press(screen.getByLabelText("Gaming"));
    await act(async () => {
      fireEvent.press(confirm());
    });

    expect(onSend).toHaveBeenCalledWith("cooking, gaming");
  });

  it("marks a selected option as checked, and unmarks it when tapped again", () => {
    renderMulti();

    fireEvent.press(screen.getByLabelText("Hiking"));
    expect(screen.getByLabelText("Hiking").props.accessibilityState.checked).toBe(true);
    expect(screen.getByText("1 selected")).toBeOnTheScreen();

    fireEvent.press(screen.getByLabelText("Hiking"));
    expect(screen.getByLabelText("Hiking").props.accessibilityState.checked).toBe(false);
    expect(screen.getByText("Pick as many as you like")).toBeOnTheScreen();
  });

  it("merges the free-text entry into the selection rather than replacing it", async () => {
    const { onSend } = renderMulti();

    fireEvent.press(screen.getByLabelText("Cooking"));
    fireEvent.changeText(input(), "  woodworking  ");
    await act(async () => {
      fireEvent.press(confirm());
    });

    expect(onSend).toHaveBeenCalledWith("cooking, woodworking");
    expect(input().props.value).toBe("");
  });

  it("sends the free-text entry alone when nothing is ticked", async () => {
    const { onSend } = renderMulti();

    fireEvent.changeText(input(), "birdwatching");
    await act(async () => {
      fireEvent.press(confirm());
    });

    expect(onSend).toHaveBeenCalledWith("birdwatching");
  });

  // #510: a rejected turn hands the answer back. The ticks are half of it —
  // restoring only the typed text would silently drop what the user chose.
  it("restores both the ticked options and the typed text when the turn is rejected", async () => {
    const onSend = jest.fn().mockResolvedValue(false);
    renderMulti({ onSend });

    fireEvent.press(screen.getByLabelText("Cooking"));
    fireEvent.changeText(input(), "woodworking");
    await act(async () => {
      fireEvent.press(confirm());
    });

    expect(screen.getByText("1 selected")).toBeOnTheScreen();
    expect(screen.getByLabelText("Cooking").props.accessibilityState.checked).toBe(true);
    expect(input().props.value).toBe("woodworking");
  });

  it("sends nothing when neither an option nor free text is given", async () => {
    const { onSend } = renderMulti();

    await act(async () => {
      fireEvent.press(confirm());
    });

    expect(onSend).not.toHaveBeenCalled();
  });

  // The selection belongs to the question that raised it. A probe re-asks the
  // same field without advancing `answered`, so it must survive; the next
  // question must start clean.
  it("clears the selection when the next question is asked", () => {
    const { rerender, onSend } = renderMulti();

    fireEvent.press(screen.getByLabelText("Cooking"));
    expect(screen.getByText("1 selected")).toBeOnTheScreen();

    rerender(
      <BarneyChat
        messages={MESSAGES}
        onSend={onSend}
        loading={false}
        input={MULTI}
        progress={{ answered: 4, total: 10 }}
        language="en"
      />
    );

    expect(screen.getByText("Pick as many as you like")).toBeOnTheScreen();
  });

  it("keeps the selection across a probe on the same question", () => {
    const { rerender, onSend } = renderMulti();

    fireEvent.press(screen.getByLabelText("Cooking"));

    rerender(
      <BarneyChat
        messages={[...MESSAGES, { role: "assistant", content: "Anything else?" }]}
        onSend={onSend}
        loading={false}
        input={MULTI}
        progress={{ answered: 3, total: 10 }}
        language="en"
      />
    );

    expect(screen.getByText("1 selected")).toBeOnTheScreen();
  });
});

// #530a: the composer is multiline, and a multiline TextInput defaults to
// submitBehavior "newline" — the return key inserted a line break and
// onSubmitEditing never fired, so the keyboard's send key did nothing.
//
// Note what each test here can and cannot prove. fireEvent invokes
// onSubmitEditing directly, so the first test only proves the handler is wired
// to send — it would pass with the bug present. The props assertion is the one
// that guards the actual fix, and neither is a substitute for pressing return
// on a real keyboard; see the evidence README.
describe("BarneyChat enter-to-send", () => {
  it("sends the draft when submitEditing fires", async () => {
    const { onSend } = renderChat();

    fireEvent.changeText(input(), "cooking, and films I've already seen");
    await act(async () => {
      fireEvent(input(), "submitEditing");
    });

    expect(onSend).toHaveBeenCalledWith("cooking, and films I've already seen");
    expect(input().props.value).toBe("");
  });

  it("keeps the keyboard open and the input multiline", () => {
    renderChat();
    // "submit" is what makes the return key fire submitEditing on a multiline
    // input without blurring; it also supersedes the deprecated blurOnSubmit.
    expect(input().props.submitBehavior).toBe("submit");
    expect(input().props.multiline).toBe(true);
  });
});

// #530b: the list followed new content unconditionally, so scrolling up to
// re-read a question was undone by the next typewriter tick. The follow
// decision itself lives in packages/shared (shouldFollowNewContent) and is
// unit-tested there; these cover the wiring around it.
describe("BarneyChat scroll pinning", () => {
  // Driving scroll and content-size events means reaching the ScrollView
  // itself; it carries no accessibility role of its own to query by.
  const scroller = () => screen.getByTestId("chat-scroll");

  function scrollTo(offset: number, contentLength: number, viewportLength = 400) {
    fireEvent.scroll(scroller(), {
      nativeEvent: {
        contentOffset: { y: offset },
        layoutMeasurement: { height: viewportLength },
        contentSize: { height: contentLength },
      },
    });
  }

  it("offers no jump-to-latest while the reader is following along", () => {
    renderChat();
    expect(screen.queryByLabelText("Jump to latest")).not.toBeOnTheScreen();
  });

  it("offers jump-to-latest once the reader scrolls up", () => {
    renderChat();
    scrollTo(0, 2000);
    expect(screen.getByLabelText("Jump to latest")).toBeOnTheScreen();
  });

  it("hides it again when the reader returns to the bottom", () => {
    renderChat();
    scrollTo(0, 2000);
    expect(screen.getByLabelText("Jump to latest")).toBeOnTheScreen();

    scrollTo(1600, 2000);
    expect(screen.queryByLabelText("Jump to latest")).not.toBeOnTheScreen();
  });

  it("re-follows the conversation when the reader answers from scrolled up", async () => {
    renderChat();
    scrollTo(0, 2000);
    expect(screen.getByLabelText("Jump to latest")).toBeOnTheScreen();

    fireEvent.changeText(input(), "a week, if I'm honest");
    await act(async () => {
      fireEvent.press(screen.getByLabelText("Send"));
    });

    expect(screen.queryByLabelText("Jump to latest")).not.toBeOnTheScreen();
  });

  // The real ScrollView reports its content height on mount; RNTL does not, so
  // these two fire it explicitly. Without it the component's "how much did the
  // content just grow?" baseline is 0 and the whole conversation counts as
  // growth — which is right on a first render and wrong here.
  function settleAt(contentLength: number) {
    act(() => {
      scroller().props.onContentSizeChange(400, contentLength);
    });
  }

  it("leaves a scrolled-up reader alone when new content arrives", () => {
    renderChat();
    settleAt(2000);
    scrollTo(0, 2000);
    expect(screen.getByLabelText("Jump to latest")).toBeOnTheScreen();

    // A typewriter tick grows the content. Before #530 this followed
    // unconditionally, dragging the reader back down; now it must not re-pin
    // someone who is deliberately reading further up.
    act(() => {
      scroller().props.onContentSizeChange(400, 2100);
    });

    expect(screen.getByLabelText("Jump to latest")).toBeOnTheScreen();
  });

  it("keeps following a reader who is at the bottom when content grows", () => {
    renderChat();
    settleAt(2000);
    scrollTo(1600, 2000);
    expect(screen.queryByLabelText("Jump to latest")).not.toBeOnTheScreen();

    // The growth itself pushes the end away; the reader was following, so the
    // chat must keep up rather than judging them adrift by the new bubble.
    act(() => {
      scroller().props.onContentSizeChange(400, 2100);
    });

    expect(screen.queryByLabelText("Jump to latest")).not.toBeOnTheScreen();
  });
});

// ADR-0037 — the interview runs in Hebrew by default, and the flag toggle
// switches it. What matters on this surface is that its own copy follows the
// language and that the toggle reports the choice back to the screen.
describe("BarneyChat language", () => {
  const PROGRESS = { answered: 2, total: 18 };

  it("renders its own copy in the language it is given", () => {
    render(<BarneyChat messages={MESSAGES} onSend={jest.fn()} loading={false} language="he" />);

    expect(screen.getByLabelText("תיבת הודעה")).toBeOnTheScreen();
    expect(screen.getByLabelText("שליחה")).toBeOnTheScreen();
    expect(screen.queryByLabelText("Message input")).toBeNull();
  });

  it("addresses a female user in the feminine and a male user in the masculine", () => {
    const { rerender } = render(
      <BarneyChat
        messages={MESSAGES}
        onSend={jest.fn()}
        loading={false}
        language="he"
        address="feminine"
      />
    );
    expect(screen.getByPlaceholderText("כתבי את התשובה שלך...")).toBeOnTheScreen();

    rerender(
      <BarneyChat
        messages={MESSAGES}
        onSend={jest.fn()}
        loading={false}
        language="he"
        address="masculine"
      />
    );
    expect(screen.getByPlaceholderText("כתוב את התשובה שלך...")).toBeOnTheScreen();
  });

  it("labels Barney's bubbles and typing indicator ברני in Hebrew", () => {
    render(<BarneyChat messages={MESSAGES} onSend={jest.fn()} loading language="he" />);

    expect(screen.getAllByText("ברני").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("ברני מקליד")).toBeOnTheScreen();
    expect(screen.queryByText("Barney")).toBeNull();
  });

  // The interview screens always pass an explicit language (Hebrew by default,
  // read from storage before the session opens). This surface's own default is
  // English because the modes that pass none — pitch and debrief — stay English.
  it("falls back to English when no language is given", () => {
    render(<BarneyChat messages={MESSAGES} onSend={jest.fn()} loading={false} />);

    expect(screen.getByLabelText("Message input")).toBeOnTheScreen();
  });

  it("renders the flag toggle only when the screen can act on it", () => {
    const { rerender } = render(
      <BarneyChat messages={MESSAGES} onSend={jest.fn()} loading={false} progress={PROGRESS} />
    );
    expect(screen.queryByTestId("language-en")).toBeNull();

    rerender(
      <BarneyChat
        messages={MESSAGES}
        onSend={jest.fn()}
        loading={false}
        progress={PROGRESS}
        onLanguageChange={jest.fn()}
      />
    );
    expect(screen.getByTestId("language-he")).toBeOnTheScreen();
    expect(screen.getByTestId("language-en")).toBeOnTheScreen();
  });

  it("reports the picked language back to the screen", () => {
    const onLanguageChange = jest.fn();
    render(
      <BarneyChat
        messages={MESSAGES}
        onSend={jest.fn()}
        loading={false}
        progress={PROGRESS}
        onLanguageChange={onLanguageChange}
      />
    );

    fireEvent.press(screen.getByTestId("language-en"));

    expect(onLanguageChange).toHaveBeenCalledWith("en");
  });

  it("marks the active language and follows a language change", () => {
    const { rerender } = render(
      <BarneyChat
        messages={MESSAGES}
        onSend={jest.fn()}
        loading={false}
        progress={PROGRESS}
        language="he"
        onLanguageChange={jest.fn()}
      />
    );
    expect(screen.getByTestId("language-he").props.accessibilityState.checked).toBe(true);

    rerender(
      <BarneyChat
        messages={MESSAGES}
        onSend={jest.fn()}
        loading={false}
        progress={PROGRESS}
        language="en"
        onLanguageChange={jest.fn()}
      />
    );

    expect(screen.getByTestId("language-en").props.accessibilityState.checked).toBe(true);
    expect(screen.getByLabelText("Message input")).toBeOnTheScreen();
  });
});
