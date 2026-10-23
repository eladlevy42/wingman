import { useEffect, useState } from "react";

// Ticks once a second while `running` is true, measuring from the moment it
// first became true; reads as 0 whenever `running` is false (computed at
// render, not reset via an effect, so the effect only ever sets state from
// the async interval callback — not synchronously in the effect body).
export function useElapsedTimer(running: boolean): number {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!running) return;
    const startedAt = Date.now();
    const interval = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(interval);
  }, [running]);

  return running ? elapsedMs : 0;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
