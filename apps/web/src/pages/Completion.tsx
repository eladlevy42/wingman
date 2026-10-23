import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { UserResponseSchema, UserStateResponseSchema } from "@wingman/shared";
import { Button } from "@/components/ui/button";
import { redirectPathForMatchingState } from "@/lib/redirectPathForState";

// The "You're In." beat (design screen 08) shown the moment the profile is
// complete — after the Phase 2 photo step — before the locked waiting screen.
// Purely celebratory: "Enter Wingman" carries the user into matching (/waiting).
export default function Completion() {
  const navigate = useNavigate();

  // Light guard: a logged-out visitor who lands here directly goes to login,
  // mirroring the other authenticated pages.
  useEffect(() => {
    const raw = localStorage.getItem("user");
    if (!raw) {
      navigate("/login", { replace: true });
      return;
    }
    let stored: unknown;
    try {
      stored = JSON.parse(raw);
    } catch {
      navigate("/login", { replace: true });
      return;
    }
    const parsed = UserResponseSchema.safeParse(stored);
    if (!parsed.success) {
      navigate("/login", { replace: true });
      return;
    }
    const userId = parsed.data.id;

    let cancelled = false;
    // WAITING is the expected matchingState on arrival here (Phase 2
    // completion already flips it — see redirectPathForState.ts), so only
    // redirect for states further along the flow. Covers back-navigation
    // after the user was already matched or assigned a date (see docs/adr/0002).
    async function guardAgainstStaleState() {
      try {
        const res = await fetch(`/api/users/${userId}/state`);
        if (!res.ok || cancelled) return;
        const state = UserStateResponseSchema.safeParse(await res.json());
        if (!state.success || cancelled) return;
        if (
          state.data.matchingState === "MATCHED" ||
          state.data.matchingState === "CHOOSING_TIMES" ||
          state.data.matchingState === "DATE_ASSIGNED"
        ) {
          navigate(redirectPathForMatchingState(state.data.matchingState), { replace: true });
        }
      } catch {
        // Transient network errors leave the user on the completion screen.
      }
    }

    guardAgainstStaleState();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex min-h-screen w-full max-w-sm flex-col px-8">
        <div className="flex flex-1 flex-col items-center justify-center gap-3.5">
          <span className="mb-2 h-1 w-10 rounded-full bg-brand" />
          <span className="text-[46px] font-bold tracking-[-0.04em] text-foreground">
            You're In.
          </span>
          <span className="text-base text-muted-foreground">Your profile is ready.</span>
        </div>
        <div className="pb-12">
          <Button
            className="h-14 w-full rounded-[18px] text-base font-semibold"
            onClick={() => navigate("/waiting")}
          >
            Enter Wingman
          </Button>
        </div>
      </div>
    </div>
  );
}
