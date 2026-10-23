import { useCallback, useEffect, useState } from "react";
import {
  AgentCostResponseSchema,
  AuditTimelineResponseSchema,
  type AgentCostResponse,
  type AuditTimelineResponse,
} from "@wingman/shared";

const TIMELINE_ERROR = "Could not load that user's timeline.";
const COSTS_ERROR = "Could not load agent costs.";

async function fetchTimeline(userId: string): Promise<AuditTimelineResponse> {
  const res = await fetch(`/api/audit/timeline/${encodeURIComponent(userId)}`);
  if (!res.ok) throw new Error("Load failed");
  return AuditTimelineResponseSchema.parse(await res.json());
}

async function fetchCosts(): Promise<AgentCostResponse> {
  const res = await fetch("/api/audit/costs");
  if (!res.ok) throw new Error("Load failed");
  return AgentCostResponseSchema.parse(await res.json());
}

interface AuditData {
  timeline: AuditTimelineResponse | null;
  timelineLoading: boolean;
  timelineError: string | null;
  loadTimeline: (userId: string) => Promise<void>;
  costs: AgentCostResponse | null;
  costsLoading: boolean;
  costsError: string | null;
  refreshCosts: () => Promise<void>;
}

// Data-fetching for the /dev/audit view (#555), kept out of the page so the
// component stays presentational (CLAUDE.md §12) — the same split
// useMatchAttemptData makes for /dev/match-pipeline.
export function useAuditData(): AuditData {
  const [timeline, setTimeline] = useState<AuditTimelineResponse | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);

  const [costs, setCosts] = useState<AgentCostResponse | null>(null);
  const [costsLoading, setCostsLoading] = useState(true);
  const [costsError, setCostsError] = useState<string | null>(null);

  const loadTimeline = useCallback(async (userId: string) => {
    if (!userId.trim()) return;
    setTimelineLoading(true);
    setTimelineError(null);
    try {
      setTimeline(await fetchTimeline(userId.trim()));
    } catch {
      setTimeline(null);
      setTimelineError(TIMELINE_ERROR);
    } finally {
      setTimelineLoading(false);
    }
  }, []);

  const refreshCosts = useCallback(async () => {
    setCostsLoading(true);
    setCostsError(null);
    try {
      setCosts(await fetchCosts());
    } catch {
      setCosts(null);
      setCostsError(COSTS_ERROR);
    } finally {
      setCostsLoading(false);
    }
  }, []);

  // The first load runs inside the effect rather than by calling refreshCosts:
  // that helper sets state synchronously on entry, and doing so in an effect
  // body triggers the cascading render react-hooks/set-state-in-effect exists
  // to catch. Settling in the callbacks also gives this a real cancellation —
  // navigating away mid-request no longer sets state on an unmounted page.
  useEffect(() => {
    let cancelled = false;
    fetchCosts()
      .then((data) => {
        if (cancelled) return;
        setCosts(data);
        setCostsError(null);
      })
      .catch(() => {
        if (cancelled) return;
        setCosts(null);
        setCostsError(COSTS_ERROR);
      })
      .finally(() => {
        if (!cancelled) setCostsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    timeline,
    timelineLoading,
    timelineError,
    loadTimeline,
    costs,
    costsLoading,
    costsError,
    refreshCosts,
  };
}
