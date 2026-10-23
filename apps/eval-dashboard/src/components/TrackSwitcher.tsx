import type { EvalTrack } from "@wingman/shared";
import { TRACKS, trackInfo } from "@/lib/tracks";
import { cn } from "@/lib/utils";

export function TrackSwitcher({
  active,
  onChange,
}: {
  active: EvalTrack;
  onChange: (track: EvalTrack) => void;
}) {
  return (
    <div>
      <div role="tablist" aria-label="Eval tracks" className="flex flex-wrap gap-1">
        {TRACKS.map((track) => (
          <button
            key={track.id}
            type="button"
            role="tab"
            aria-selected={track.id === active}
            onClick={() => onChange(track.id)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-sm font-medium",
              track.id === active
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            {track.name.split("—")[0].trim()}
          </button>
        ))}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{trackInfo(active).description}</p>
    </div>
  );
}
