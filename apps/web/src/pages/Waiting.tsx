// The locked screen shown from Phase 2 completion until Barney finds a match.
// Polls the user's matching state and redirects to /pitch once MATCHED — see
// issue #48. AppLayout is kept: AppNav has no navigation links, and
// NotificationBanner is a separately-shipped, already-tested feature (#80)
// whose e2e suite exercises it specifically on this route.
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  UserResponseSchema,
  UserStateResponseSchema,
  TriggerMatchStartResponseSchema,
  OrchestrationStatusResponseSchema,
} from "@wingman/shared";
import AppLayout from "@/components/AppLayout";
import { Button } from "@/components/ui/button";

// Mirrors the backend's MATCH_COOLDOWN_MINUTES default (.env.example) — no
// shared config channel exists yet between apps/api and apps/web, so this
// duplicates the value rather than reading the real env var. Keep both in sync.
const MATCH_COOLDOWN_MINUTES = 1;
const MS_PER_MINUTE = 60_000;
const POLL_INTERVAL_MS = Math.max(5000, MATCH_COOLDOWN_MINUTES * MS_PER_MINUTE);

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

// Faster cadence while a manually-triggered cycle is in flight (#361) — the
// user is actively watching; the slow interval resumes once it settles.
const ACTIVE_POLL_INTERVAL_MS = 4000;

export default function Waiting() {
  const navigate = useNavigate();
  const userIdRef = useRef<string | null>(null);
  // "idle" → button available; "searching" → a cycle is running (ours or an
  // in-flight one we joined); "exhausted" → a cycle finished with no match.
  const [searchPhase, setSearchPhase] = useState<"idle" | "searching" | "exhausted">("idle");
  // Disables the button between the click and the POST resolving — without it
  // a fast double-click fires two trigger requests (the server lock makes the
  // second harmless, but the guard existed before #361 and belongs here).
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reads the logged-in user once on mount, then polls GET /api/users/:id/state
  // and unlocks the screen (redirect to /pitch) the moment matchingState flips
  // to MATCHED — the only way out of this locked screen.
  useEffect(() => {
    const id = readStoredUserId();
    if (!id) {
      navigate("/login", { replace: true });
      return;
    }
    userIdRef.current = id;

    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`/api/users/${id}/state`);
        if (!res.ok || cancelled) return;
        const state = UserStateResponseSchema.safeParse(await res.json());
        if (state.success && !cancelled) {
          if (state.data.matchingState === "MATCHED") navigate("/pitch");
          if (state.data.matchingState === "CHOOSING_TIMES") navigate("/choose-times");
          if (state.data.matchingState === "DATE_ASSIGNED") navigate("/blind-date");
        }
      } catch {
        // Transient network errors are silently retried on the next tick.
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [navigate]);

  // While a triggered cycle runs (#361), watch it closely: poll state (to
  // navigate the moment a match lands) and the orchestration status (to know
  // when the cycle finished). A finished cycle with the user still WAITING is
  // the honest "nobody available right now" outcome — not an error.
  useEffect(() => {
    if (searchPhase !== "searching") return;
    const id = userIdRef.current;
    if (!id) return;

    let cancelled = false;

    async function watch() {
      try {
        const stateRes = await fetch(`/api/users/${id}/state`);
        if (cancelled) return;
        if (stateRes.ok) {
          const state = UserStateResponseSchema.safeParse(await stateRes.json());
          if (state.success && !cancelled) {
            if (state.data.matchingState === "MATCHED") return navigate("/pitch");
            if (state.data.matchingState === "CHOOSING_TIMES") return navigate("/choose-times");
            if (state.data.matchingState === "DATE_ASSIGNED") return navigate("/blind-date");
          }
        }
        const statusRes = await fetch(`/api/match/orchestration-status`);
        if (!statusRes.ok || cancelled) return;
        const status = OrchestrationStatusResponseSchema.safeParse(await statusRes.json());
        if (status.success && !cancelled && !status.data.running) {
          setSearchPhase("exhausted");
        }
      } catch {
        // Transient errors retry on the next tick.
      }
    }

    watch();
    const interval = setInterval(watch, ACTIVE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [searchPhase, navigate]);

  // Manual trigger (issue #185, async since #361): the cycle runs in the
  // background — this only starts it (or joins one already in flight) and
  // flips the page into its watching state. Real negotiations take minutes,
  // so there is nothing synchronous to wait for.
  async function handleTriggerMatch() {
    const id = userIdRef.current;
    if (!id || isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/users/${id}/trigger-match`, { method: "POST" });
      if (!res.ok) {
        setError("Could not start the search — please try again.");
        return;
      }
      const parsed = TriggerMatchStartResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        setError("Unexpected response from server");
        return;
      }
      // started:false just means a cycle is already in flight — join it.
      setSearchPhase("searching");
    } catch {
      setError("Network error — please try again");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AppLayout>
      <div className="flex flex-1 flex-col items-center justify-center px-8 py-16">
        {/* Concentric pulse (design screen 09) — Tailwind's built-in ping,
            staggered for a radar-like effect. */}
        <div className="relative flex h-24 w-24 items-center justify-center">
          <span className="absolute h-10 w-10 rounded-full bg-brand/70 animate-ping" />
          <span
            className="absolute h-10 w-10 rounded-full bg-brand/70 animate-ping"
            style={{ animationDelay: "1s" }}
          />
          <span className="relative h-3.5 w-3.5 rounded-full bg-brand" />
        </div>

        <div className="mt-9 flex flex-col items-center gap-3 text-center">
          <h1 className="text-[30px] font-bold leading-tight tracking-[-0.03em] text-foreground">
            Finding
            <br />
            your match.
          </h1>
          <p className="max-w-[270px] text-[15px] leading-relaxed text-muted-foreground">
            Wingman is reviewing the community to introduce you thoughtfully. You'll be notified
            when there's a match worth your time.
          </p>
        </div>

        <div className="mt-9 flex items-center gap-2">
          <span className="h-[7px] w-[7px] rounded-full bg-brand" />
          <span className="font-mono text-xs uppercase tracking-[0.1em] text-muted-foreground">
            Searching
          </span>
        </div>

        {import.meta.env.DEV && (
          <div className="mt-10 text-center">
            <p className="mb-2 text-xs text-muted-foreground/60">Dev only</p>
            {searchPhase === "searching" ? (
              <p data-testid="search-progress" className="text-sm font-medium text-brand">
                Barney is negotiating for you — this can take a few minutes…
              </p>
            ) : (
              <Button variant="ghost" onClick={handleTriggerMatch} disabled={isSubmitting}>
                {searchPhase === "exhausted" ? "Search again" : "Trigger match now"}
              </Button>
            )}
            {searchPhase === "exhausted" && (
              <p data-testid="search-exhausted" className="mt-3 text-sm text-muted-foreground">
                Barney couldn't pair you this round — there's no one else waiting right now. A
                manual search always ends in a match when anyone is available.
              </p>
            )}
            {error && <p className="mt-3 text-sm text-muted-foreground">{error}</p>}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
