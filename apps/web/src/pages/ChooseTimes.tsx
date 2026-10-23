// Choose-your-times step (#248, role-based): when both users say "yeah", one is
// picked at random as the proposer and the other is the chooser.
//   - Proposer: picks up to three of a shared set of offered slots ("When are
//     you free?"), then waits.
//   - Chooser: waits until the proposer has picked, then chooses the single
//     final date/time from the proposer's slots — which schedules the Blind Date
//     and moves both users to DATE_ASSIGNED (followed here to /blind-date).
// Design screen 13.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check } from "lucide-react";
import {
  UserResponseSchema,
  UserStateResponseSchema,
  SubmitAvailabilityResponseSchema,
} from "@wingman/shared";
import { redirectPathForMatchingState } from "@/lib/redirectPathForState";
import { stickyHasSubmitted } from "@/lib/stickyHasSubmitted";
import AppLayout from "@/components/AppLayout";

// Mirrors the backend's MAX_PROPOSED_SLOTS (scheduling.service.ts) — no shared
// config channel exists between apps/api and apps/web, so this duplicates the
// value. Keep both in sync.
const MAX_PROPOSED_SLOTS = 3;
const POLL_INTERVAL_MS = 3000;
const SUBMIT_ERROR_MESSAGE = "Could not save your choice. Please try again.";

type TimeRole = "proposer" | "chooser";

function readStoredUserId(): string | null {
  const raw = localStorage.getItem("user");
  if (!raw) return null;
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = UserResponseSchema.safeParse(stored);
  return parsed.success ? parsed.data.id : null;
}

function formatSlot(iso: string): { day: string; time: string } {
  const d = new Date(iso);
  return {
    day: d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }),
    time: d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
  };
}

// The radar pulse used by both waiting states.
function Pending({ title, body }: { title: string; body: string }) {
  return (
    <AppLayout>
      <div className="mx-auto flex min-h-[80vh] w-full max-w-sm flex-col items-center justify-center gap-9 px-8">
        <div className="relative flex h-24 w-24 items-center justify-center">
          <span className="absolute h-10 w-10 rounded-full bg-brand/70 animate-ping" />
          <span
            className="absolute h-10 w-10 rounded-full bg-brand/70 animate-ping"
            style={{ animationDelay: "1s" }}
          />
          <span className="relative h-3.5 w-3.5 rounded-full bg-brand" />
        </div>
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="text-[30px] font-bold tracking-[-0.03em] text-foreground">{title}</span>
          <span className="max-w-[270px] text-[15px] leading-relaxed text-muted-foreground">
            {body}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="h-[7px] w-[7px] rounded-full bg-brand" />
          <span className="font-mono text-xs uppercase tracking-[0.1em] text-muted-foreground">
            Pending
          </span>
        </div>
      </div>
    </AppLayout>
  );
}

export default function ChooseTimes() {
  const navigate = useNavigate();
  const userIdRef = useRef<string | null>(null);
  const matchIdRef = useRef<string | null>(null);
  const [role, setRole] = useState<TimeRole | null>(null);
  const [candidateSlots, setCandidateSlots] = useState<string[]>([]);
  const [proposedSlots, setProposedSlots] = useState<string[]>([]);
  const [hasSubmitted, setHasSubmitted] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Loads and then polls the choose-times state. Anyone not in CHOOSING_TIMES is
  // bounced to wherever their matchingState belongs (e.g. the date is set ->
  // /blind-date), so this page can't be reached out of turn. Polling lets the
  // chooser's screen appear the moment the proposer picks, and the proposer
  // follow through to the reveal once the chooser locks in the date.
  useEffect(() => {
    const userId = readStoredUserId();
    if (!userId) {
      navigate("/login", { replace: true });
      return;
    }
    userIdRef.current = userId;

    let cancelled = false;

    async function refresh(initial: boolean) {
      try {
        const res = await fetch(`/api/users/${userId}/state`);
        if (!res.ok || cancelled) return;
        const parsed = UserStateResponseSchema.safeParse(await res.json());
        if (!parsed.success || cancelled) return;

        if (parsed.data.matchingState !== "CHOOSING_TIMES") {
          navigate(redirectPathForMatchingState(parsed.data.matchingState), { replace: true });
          return;
        }
        matchIdRef.current = parsed.data.matchId ?? null;
        setRole(parsed.data.timeRole ?? null);
        setCandidateSlots(parsed.data.candidateSlots ?? []);
        setProposedSlots(parsed.data.proposedSlots ?? []);
        // Sticky (#547): a poll already in flight when the proposer's submit
        // resolves can land afterwards carrying the pre-submit `false`,
        // knocking the "Times sent." pending view back to the picker until the
        // next poll restores it. The server never un-submits, so only ever OR
        // the incoming value in.
        setHasSubmitted((prev) => stickyHasSubmitted(prev, parsed.data.hasSubmittedAvailability));
      } catch {
        if (!cancelled && initial) setError("Could not load your times. Please refresh the page.");
      } finally {
        if (!cancelled && initial) setLoading(false);
      }
    }

    refresh(true);
    const interval = setInterval(() => refresh(false), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [navigate]);

  const isProposer = role === "proposer";
  const maxSelect = isProposer ? MAX_PROPOSED_SLOTS : 1;
  const offered = isProposer ? candidateSlots : proposedSlots;

  const toggleSlot = useCallback(
    (iso: string) => {
      setSelected((prev) => {
        if (prev.includes(iso)) return prev.filter((s) => s !== iso);
        if (maxSelect === 1) return [iso];
        if (prev.length >= maxSelect) return prev;
        return [...prev, iso];
      });
    },
    [maxSelect]
  );

  const handleConfirm = useCallback(async () => {
    const userId = userIdRef.current;
    const matchId = matchIdRef.current;
    if (!userId || !matchId || selected.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/match/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId, userId, slots: selected }),
      });
      if (!res.ok) throw new Error("Submit failed");
      const parsed = SubmitAvailabilityResponseSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error("Unexpected response");
      if (parsed.data.matchingState === "DATE_ASSIGNED") {
        navigate("/blind-date");
        return;
      }
      // Proposer just forwarded their slots — drop into the waiting state.
      setHasSubmitted(true);
      setSelected([]);
    } catch {
      setError(SUBMIT_ERROR_MESSAGE);
    } finally {
      setSubmitting(false);
    }
  }, [selected, submitting, navigate]);

  if (loading) {
    return (
      <AppLayout>
        <div className="mx-auto flex min-h-[80vh] w-full max-w-sm items-center justify-center px-8">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </AppLayout>
    );
  }

  // Proposer has forwarded their times and is waiting on the chooser.
  if (isProposer && hasSubmitted) {
    return (
      <Pending
        title="Times sent."
        body="We'll lock in your date the moment your match picks one of your times."
      />
    );
  }

  // Chooser is waiting for the proposer to share their availability.
  if (!isProposer && proposedSlots.length === 0) {
    return (
      <Pending
        title="Almost there."
        body="Waiting for your match to share the times they're free — you'll pick the final one."
      />
    );
  }

  const heading = isProposer ? "When are you free?" : "Pick your date.";
  const subheading = isProposer
    ? "Pick up to three times that work for you."
    : "Choose the one that works best — this locks in your date.";
  const cta = isProposer ? "Send my times" : "Confirm date";

  return (
    <AppLayout>
      <div className="mx-auto flex min-h-[80vh] w-full max-w-sm flex-col px-8 pt-9">
        <div className="flex flex-1 flex-col">
          <div className="flex items-baseline justify-between">
            <h1 className="text-[30px] font-bold tracking-[-0.03em] text-foreground">{heading}</h1>
            <span className="font-mono text-xs tracking-[0.08em] text-brand">
              {selected.length} / {maxSelect}
            </span>
          </div>
          <p className="mt-3 text-[15.5px] leading-normal text-muted-foreground">{subheading}</p>

          <div className="mt-7 flex flex-col gap-2.5">
            {offered.map((iso) => {
              const { day, time } = formatSlot(iso);
              const isSelected = selected.includes(iso);
              return (
                <button
                  key={iso}
                  type="button"
                  data-testid="time-slot"
                  onClick={() => toggleSlot(iso)}
                  className={`flex items-center justify-between rounded-[18px] px-[18px] py-[17px] text-left transition-colors ${
                    isSelected ? "border-[1.5px] border-brand" : "border border-border"
                  }`}
                >
                  <span
                    className={`text-[15.5px] font-medium ${
                      isSelected ? "text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {day} <span className="font-normal text-muted-foreground">· {time}</span>
                  </span>
                  {isSelected ? (
                    <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-brand">
                      <Check className="h-3 w-3 text-white" strokeWidth={3} />
                    </span>
                  ) : (
                    <span className="h-[22px] w-[22px] rounded-full border-[1.5px] border-border" />
                  )}
                </button>
              );
            })}
          </div>

          {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
        </div>
        <div className="pb-12 pt-6">
          <button
            onClick={handleConfirm}
            disabled={selected.length === 0 || submitting}
            className="w-full rounded-[18px] bg-primary px-4 py-[18px] text-base font-semibold text-primary-foreground disabled:opacity-50"
          >
            {submitting ? "Saving…" : cta}
          </button>
        </div>
      </div>
    </AppLayout>
  );
}
