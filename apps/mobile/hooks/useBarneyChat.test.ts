import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DRAFT_KEPT_SUFFIX, INIT_ERROR_MESSAGE, SEND_ERROR_MESSAGE } from "./useBarneyChat";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(__dirname, "..");

const read = (relative: string) => readFileSync(path.join(mobileRoot, relative), "utf8");

/**
 * #494: the session-init error told the user to "Pull down to try again" on a
 * screen that has no pull-to-refresh — the string was adapted from the web copy
 * ("Please refresh the page"), where reloading really is available. With the
 * composer disabled by `initFailed`, no header, and no address bar on a device,
 * force-quitting the app was the only way out.
 *
 * Rendering is out of scope for this suite by design (see vitest.config.ts), so
 * these guard the two halves that can be checked without a renderer: the copy
 * promises nothing the screen cannot do, and the screen that replaces it offers
 * a real way forward.
 */
describe("session-init failure copy", () => {
  it("promises no gesture the screen does not implement", () => {
    expect(INIT_ERROR_MESSAGE).not.toMatch(/pull\s*(down|to)/i);
    expect(INIT_ERROR_MESSAGE).not.toMatch(/refresh|reload|swipe/i);
  });

  it("still says what went wrong", () => {
    expect(INIT_ERROR_MESSAGE).toMatch(/could not start the session/i);
    // The per-turn failure is a different message: a turn that fails is
    // recoverable by simply sending again. Since #510 it also says the answer
    // was kept, which is asserted in its own block below.
    expect(SEND_ERROR_MESSAGE).not.toBe(INIT_ERROR_MESSAGE);
  });

  // If pull-to-refresh is ever actually built, the copy above may legitimately
  // mention it again — but only then. This is the pairing the original bug
  // broke: an instruction with no implementation behind it.
  it("has no pull-to-refresh anywhere in the app to promise", () => {
    const screen = read("app/barney/phase1.tsx");
    const chat = read("components/BarneyChat.tsx");
    // ScreenFailure is where the init-failure copy actually renders since #508,
    // so it belongs in this guard too.
    const failure = read("components/ScreenFailure.tsx");
    for (const source of [screen, chat, failure]) {
      expect(source).not.toMatch(/RefreshControl|onRefresh|refreshing=/);
    }
  });

  // Deliberately narrower than it was. Asserting on the JSX — `onRetry={...}`
  // wired to a particular identifier, a button labelled "Try again" — passes
  // whether or not retryInit does anything, and breaks on a Prettier reflow or
  // a prop rename that changes no behaviour. What is worth pinning without a
  // renderer is only that the screen still takes the branch: that a failed init
  // routes somewhere other than the inert chat surface. Whether the retry
  // actually restarts the session is a device-run question, and is covered by
  // the evidence for this branch.
  it("routes a failed init away from the dead chat surface", () => {
    const screen = read("app/barney/phase1.tsx");
    expect(screen).toMatch(/chat\.initFailed/);
    // Was the screen-local InterviewStartFailed until #508 extracted the shared
    // ScreenFailure. The name changed; what this pins did not — a failed init
    // still has to route somewhere other than the inert chat surface.
    expect(screen).toMatch(/ScreenFailure/);
  });

  // The escape hatch is the half of that branch that actually gets the user
  // somewhere, and #508 is what made it a prop — so it is worth pinning that
  // Phase 1 still passes one, and that it is still sign-out rather than the
  // boot screen's "Sign in instead".
  it("still offers a way out of the failed interview", () => {
    const screen = read("app/barney/phase1.tsx");
    expect(screen).toMatch(/escape=\{\{/);
    expect(screen).toMatch(/label: "Sign out"/);
    expect(screen).toMatch(/clearUser\(\)/);
  });
});

/**
 * #510: `send` cleared the composer before the request was issued, so any
 * failure afterwards — a network drop, a 500, an expired session — took the
 * user's answer with it and then offered "please try again" with nothing left
 * to try again with.
 *
 * Rendering stays out of scope for this suite (see vitest.config.ts), so the
 * behavioural proof lives in the web E2E spec, which fails the request
 * mid-turn and asserts the composer still holds the answer. What is worth
 * pinning here is the half that is checkable without a renderer: the copy
 * matches what the code now actually does, and the composer takes the
 * restore branch at all.
 */
describe("a failed turn keeps the user's answer", () => {
  it("tells the user their answer was kept", () => {
    expect(SEND_ERROR_MESSAGE).toMatch(/still in the box/i);
  });

  it("does not promise a retry it cannot honour", () => {
    // The old copy said "Please try again" next to an emptied composer. Either
    // the message keeps the answer or it stops offering the retry.
    expect(SEND_ERROR_MESSAGE).toMatch(/again/i);
    expect(DRAFT_KEPT_SUFFIX).toMatch(/still in the box/i);
  });

  // A server-authored reason ("AI service temporarily unavailable") replaces the
  // generic copy entirely, so it needs the reassurance appended or those turns
  // would silently lose it — the draft is restored either way.
  it("appends the reassurance to server-authored turn errors", () => {
    const source = read("hooks/useBarneyChat.ts");
    expect(source).toMatch(/err\.message \+ DRAFT_KEPT_SUFFIX/);
  });

  it("restores the draft only on an explicit failure", () => {
    const chat = read("components/BarneyChat.tsx");
    expect(chat).toMatch(/accepted === false/);
    expect(chat).toMatch(/setDraft\(trimmed\)/);
  });

  // The age picker and choice chips submit values the composer never held.
  // Restoring one into the draft would strand a stale "29" in the text box, so
  // they deliberately stay on the non-restoring path.
  it("keeps picker and chip submissions off the restoring path", () => {
    const chat = read("components/BarneyChat.tsx");
    expect(chat).toMatch(/onPress=\{\(\) => send\(option\.value\)\}/);
    expect(chat).toMatch(/onSubmitEditing=\{\(\) => void sendDraft\(\)\}/);
  });
});

/**
 * #511: `phaseComplete` only ever arrives on the stream's `done` event, so a
 * stream that died after the deltas but before `done` left a user sitting in an
 * interview the api had already finished and transitioned them out of.
 *
 * The decision itself — does this state mean the phase is over — lives in
 * `packages/shared/src/interviewCompletion.ts` and is unit-tested there, so both
 * clients answer it identically. Rendering stays out of scope for this suite
 * (see vitest.config.ts), so what is worth pinning here is the wiring: the hook
 * asks the server before it renders a dead end, and it fails closed.
 */
describe("a truncated phase-completing turn asks the server", () => {
  it("re-checks user state before showing the turn error", () => {
    const source = read("hooks/useBarneyChat.ts");
    expect(source).toMatch(/phaseCompletedOnServer/);
    // The check has to come before the error bubble, not after it.
    const recovery = source.indexOf("await phaseCompletedOnServer()");
    const errorBubble = source.indexOf("content: turnErrorMessage(err)");
    expect(recovery).toBeGreaterThan(-1);
    expect(recovery).toBeLessThan(errorBubble);
  });

  it("decides completion with the shared predicate rather than its own rule", () => {
    const source = read("hooks/useBarneyChat.ts");
    expect(source).toMatch(/interviewPhaseCompleted\(mode, state\)/);
  });

  // A lookup that fails must not be read as "the phase finished" — that would
  // skip someone past an interview they still owe.
  it("fails closed when the state lookup itself fails", () => {
    const source = read("hooks/useBarneyChat.ts");
    const helper = source.slice(source.indexOf("const phaseCompletedOnServer"));
    expect(helper.slice(0, helper.indexOf("}, [userId, mode])"))).toMatch(
      /catch \{\s*return false;/
    );
  });
});

/**
 * The language toggle used to switch only Barney's next reply, leaving the
 * conversation on screen — and its answer chips — in the language the user had
 * just switched away from (ADR-0037). What the hook does with the restated
 * question is rendered and asserted in useBarneyChat.language.test.tsx; without
 * a renderer, what is pinned here is that both interview screens route the
 * toggle through the restate call instead of only saving the preference.
 */
describe("the language toggle restates the question on screen", () => {
  it.each(["app/barney/phase1.tsx", "app/barney/phase2.tsx"])(
    "%s sends the toggle through changeLanguage",
    (screen) => {
      const source = read(screen);
      expect(source).toMatch(/onLanguageChange=\{handleLanguageChange\}/);
      expect(source).toMatch(/void changeLanguage\(next\)/);
    }
  );

  // Barney's lines are conjugated by the api from the registered gender; the
  // chat's own copy has to be handed the same form, or a female user is told
  // "כתבו" under a question that says "את".
  it.each(["app/barney/phase1.tsx", "app/barney/phase2.tsx"])(
    "%s hands the chat the user's address form",
    (screen) => {
      const source = read(screen);
      expect(source).toMatch(/const address = useAddressForm\(\);/);
      expect(source).toMatch(/address=\{address\}/);
    }
  );

  it("takes the turn lock, so a restated question cannot interleave with a reply", () => {
    const source = read("hooks/useBarneyChat.ts");
    const helper = source.slice(source.indexOf("const changeLanguage = useCallback"));
    const body = helper.slice(0, helper.indexOf("[busy, done, unmounted]"));
    expect(body).toMatch(/turnActiveRef\.current \|\| busy \|\| done\) return;/);
  });
});
