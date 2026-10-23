import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight, Compass, X } from "lucide-react";

// POC-only demo navigator. A floating widget that lets us step through every
// page in order (Prev/Next) or jump straight to any page via the dropdown,
// so we can walk the whole flow during a demo without typing URLs. This is a
// throwaway demo aid — not part of the real product UX.
//
// It starts collapsed (a small compass button) and is anchored to the middle of
// the right edge, deliberately clear of the top nav bar and every page's bottom
// action buttons (chat Send, Yeah/Neh, choice chips) so it never sits on top of
// a real control. While collapsed it renders no visible text and no page list,
// so it cannot collide with the app's own elements (or a screen reader).

type DemoPage = { path: string; label: string };

// The real app's pages, listed in the order we'd naturally walk them in a demo.
const DEMO_PAGES: DemoPage[] = [
  { path: "/", label: "Splash" },
  { path: "/welcome", label: "Welcome" },
  { path: "/register", label: "Register" },
  { path: "/authenticate", label: "Verify University" },
  { path: "/login", label: "Login" },
  { path: "/verified", label: "Verified" },
  { path: "/barney/phase1", label: "Barney — Phase 1" },
  { path: "/barney/phase2", label: "Barney — Phase 2" },
  { path: "/completion", label: "Completion" },
  { path: "/waiting", label: "Waiting" },
  { path: "/pitch", label: "Pitch" },
  { path: "/choose-times", label: "Choose Times" },
  { path: "/blind-date", label: "Blind Date" },
  { path: "/debrief", label: "Debrief" },
];

export default function DemoNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const currentIndex = DEMO_PAGES.findIndex((p) => p.path === location.pathname);
  const prev = currentIndex > 0 ? DEMO_PAGES[currentIndex - 1] : null;
  const next =
    currentIndex >= 0 && currentIndex < DEMO_PAGES.length - 1 ? DEMO_PAGES[currentIndex + 1] : null;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Open demo navigator"
        className="fixed right-3 top-1/2 z-[9999] flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg"
      >
        <Compass className="h-5 w-5" />
      </button>
    );
  }

  return (
    <div className="fixed right-3 top-1/2 z-[9999] flex -translate-y-1/2 items-center gap-2 rounded-full border border-border bg-background/95 px-2 py-2 shadow-lg backdrop-blur">
      <span className="pl-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
        Demo
      </span>

      <button
        onClick={() => prev && navigate(prev.path)}
        disabled={!prev}
        aria-label="Previous page"
        className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-accent disabled:opacity-30"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>

      <select
        value={currentIndex >= 0 ? location.pathname : ""}
        onChange={(e) => navigate(e.target.value)}
        aria-label="Jump to page"
        className="max-w-[170px] rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {currentIndex < 0 && (
          <option value="" disabled>
            (unlisted page)
          </option>
        )}
        {DEMO_PAGES.map((p) => (
          <option key={p.path} value={p.path}>
            {p.label}
          </option>
        ))}
      </select>

      <button
        onClick={() => next && navigate(next.path)}
        disabled={!next}
        aria-label="Next page"
        className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-accent disabled:opacity-30"
      >
        <ChevronRight className="h-4 w-4" />
      </button>

      <button
        onClick={() => setOpen(false)}
        aria-label="Hide demo navigator"
        className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
