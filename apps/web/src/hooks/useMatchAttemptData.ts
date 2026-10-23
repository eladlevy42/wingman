import { useCallback, useEffect, useRef, useState } from "react";
import {
  MatchAttemptSummarySchema,
  MatchAttemptDetailSchema,
  type MatchAttemptSummary,
  type MatchAttemptDetail,
} from "@wingman/shared";

const LOAD_ERROR = "Could not load match attempts. Please refresh.";
const POLL_MS = 2000;

async function fetchAttempts(): Promise<MatchAttemptSummary[]> {
  const res = await fetch("/api/match-attempts");
  if (!res.ok) throw new Error("Load failed");
  return MatchAttemptSummarySchema.array().parse(await res.json());
}

async function fetchAttempt(id: string): Promise<MatchAttemptDetail> {
  const res = await fetch(`/api/match-attempts/${id}`);
  if (!res.ok) throw new Error("Load failed");
  return MatchAttemptDetailSchema.parse(await res.json());
}

interface MatchAttemptData {
  attempts: MatchAttemptSummary[];
  listLoading: boolean;
  selectedId: string | null;
  detail: MatchAttemptDetail | null;
  error: string | null;
  selectAttempt: (id: string) => void;
  refreshList: () => Promise<void>;
}

// Data-fetching and live-poll concerns for the match pipeline dev view
// (issue #253), extracted out of MatchPipeline.tsx so that component stays
// presentational (CLAUDE.md §12).
export function useMatchAttemptData(): MatchAttemptData {
  const [attempts, setAttempts] = useState<MatchAttemptSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rawDetail, setDetail] = useState<MatchAttemptDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // rawDetail can lag one render behind selectedId (it's only updated once a
  // fetch resolves) — derive the displayed value during render rather than
  // resetting state in an effect, so a selection change or failed fetch never
  // shows the previous attempt's data mislabeled as the current one.
  const detail = rawDetail && rawDetail.id === selectedId ? rawDetail : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshList = useCallback(async () => {
    setListLoading(true);
    setError(null);
    try {
      const data = await fetchAttempts();
      if (mountedRef.current) setAttempts(data);
    } catch {
      if (mountedRef.current) setError(LOAD_ERROR);
    } finally {
      if (mountedRef.current) setListLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchAttempts();
        if (!cancelled && mountedRef.current) setAttempts(data);
      } catch {
        if (!cancelled && mountedRef.current) setError(LOAD_ERROR);
      } finally {
        if (!cancelled && mountedRef.current) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the selected attempt's detail whenever selection changes. The
  // `detail` derivation above hides rawDetail until it matches selectedId, so
  // there's nothing to reset here even while this fetch is in flight or fails.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    fetchAttempt(selectedId)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch(() => {
        if (!cancelled) setError(LOAD_ERROR);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Live view: poll the selected attempt while it's still RUNNING.
  useEffect(() => {
    if (!selectedId || detail?.status !== "RUNNING") return;
    const interval = setInterval(async () => {
      try {
        const data = await fetchAttempt(selectedId);
        if (!mountedRef.current) return;
        setDetail(data);
        if (data.status !== "RUNNING") refreshList();
      } catch {
        // Transient poll failure — try again next tick rather than surfacing
        // a banner for a background refresh.
      }
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [selectedId, detail?.status, refreshList]);

  return {
    attempts,
    listLoading,
    selectedId,
    detail,
    error,
    selectAttempt: setSelectedId,
    refreshList,
  };
}
