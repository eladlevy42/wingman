import { useCallback, useEffect, useState, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { UserStateResponseSchema, DecideMatchResponseSchema } from "@wingman/shared";

const DECIDE_ERROR_MESSAGE = "Could not record your decision. Please try again.";
const POLL_INTERVAL_MS = 2500;

// Owns the Yeah/Neh decision and the post-"yeah" wait for the other user.
// Takes the match/user id refs populated by usePitchSession's init effect.
export function usePitchDecision(
  matchIdRef: RefObject<string | null>,
  userIdRef: RefObject<string | null>
) {
  const navigate = useNavigate();
  // Gate the reveal/decision screen behind an explicit tap so the user can read
  // Barney's answer to their final (3rd) question before the chat is replaced by
  // the Yeah/Neh screen. Without this, questionsLeft hitting 0 swapped the view
  // immediately and the last answer was never seen.
  const [showDecision, setShowDecision] = useState(false);
  const [decisionMade, setDecisionMade] = useState(false);
  const [chosenDecision, setChosenDecision] = useState<"yeah" | "nah" | null>(null);
  const [decisionPending, setDecisionPending] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  // After saying "yeah", wait on the other user: poll state and follow it to the
  // choose-times step (both said yeah) or straight to the reveal, and bail to
  // /waiting if the match fell through (the other user said nah).
  useEffect(() => {
    if (!decisionMade || chosenDecision !== "yeah") return;
    const userId = userIdRef.current;
    if (!userId) return;
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/users/${userId}/state`);
        if (!res.ok || cancelled) return;
        const parsed = UserStateResponseSchema.safeParse(await res.json());
        if (!parsed.success || cancelled) return;
        const s = parsed.data.matchingState;
        if (s === "CHOOSING_TIMES") navigate("/choose-times");
        else if (s === "DATE_ASSIGNED") navigate("/blind-date");
        else if (s === "WAITING" || s === "REJECTED") navigate("/waiting");
      } catch {
        // Transient errors retry on the next tick.
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [decisionMade, chosenDecision, navigate, userIdRef]);

  const handleDecision = useCallback(
    async (decision: "yeah" | "nah") => {
      if (decisionPending) return;
      setDecisionPending(true);
      setDecisionError(null);
      try {
        const res = await fetch("/api/match/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            matchId: matchIdRef.current,
            userId: userIdRef.current,
            decision,
          }),
        });
        if (!res.ok) throw new Error("Decide failed");
        const decideParsed = DecideMatchResponseSchema.safeParse(await res.json());
        if (!decideParsed.success) throw new Error("Unexpected decide response");
        setChosenDecision(decision);
        setDecisionMade(true);
        // A "nah" ends this match immediately — the backend rejects it and
        // returns the user to matching, so there's nothing to wait for.
        if (decision === "nah") navigate("/waiting", { replace: true });
      } catch {
        setDecisionError(DECIDE_ERROR_MESSAGE);
      } finally {
        setDecisionPending(false);
      }
    },
    [decisionPending, navigate, matchIdRef, userIdRef]
  );

  return {
    showDecision,
    setShowDecision,
    decisionMade,
    chosenDecision,
    decisionPending,
    decisionError,
    handleDecision,
  };
}
