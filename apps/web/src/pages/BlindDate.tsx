// Reveal screen shown once matchingState flips to DATE_ASSIGNED (#57): the
// "It's a date." confirmation card (design screen 14) wired to the real
// auto-scheduled venue/dateTime and the matched partner's revealed profile.
// Fire-and-forget per docs/adr/0012 — no cancel/reschedule actions; the only
// action is exporting the date to the user's calendar.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  UserResponseSchema,
  BlindDateResponseSchema,
  UserStateResponseSchema,
} from "@wingman/shared";
import type { BlindDateResponse } from "@wingman/shared";
import AppLayout from "@/components/AppLayout";

// The pair of photos (you + your match) clipped into a single heart — the
// centrepiece of the date card. Self fills the left half, partner the right,
// with a hairline divider. Degrades to whichever photo exists if one is
// missing, so the heart is never empty.
function HeartPhotos({ selfUrl, partnerUrl }: { selfUrl: string; partnerUrl: string }) {
  const HEART =
    "M23.6,0c-3.4,0-6.3,2.7-7.6,5.6C14.7,2.7,11.8,0,8.4,0C3.8,0,0,3.8,0,8.4c0,9.4,9.5,11.9,16,21.2c6.1-9.3,16-12,16-21.2C32,3.8,28.2,0,23.6,0z";
  const both = selfUrl && partnerUrl;
  return (
    <svg viewBox="0 0 32 29.6" className="h-36 w-36" role="img" aria-label="You and your match">
      <defs>
        <clipPath id="date-heart">
          <path d={HEART} />
        </clipPath>
      </defs>
      <g clipPath="url(#date-heart)">
        <rect x="0" y="0" width="32" height="29.6" fill="#eef0f2" />
        {both ? (
          <>
            <image
              href={selfUrl}
              x="0"
              y="0"
              width="16"
              height="29.6"
              preserveAspectRatio="xMidYMid slice"
            />
            <image
              href={partnerUrl}
              x="16"
              y="0"
              width="16"
              height="29.6"
              preserveAspectRatio="xMidYMid slice"
            />
            <line x1="16" y1="0" x2="16" y2="29.6" stroke="white" strokeWidth="0.6" />
          </>
        ) : (
          <image
            href={partnerUrl || selfUrl}
            x="0"
            y="0"
            width="32"
            height="29.6"
            preserveAspectRatio="xMidYMid slice"
          />
        )}
      </g>
      <path d={HEART} fill="none" stroke="white" strokeWidth="0.75" />
    </svg>
  );
}

// A single, warm one-liner about the partner for the card — the first available
// personality signal, so the card never shows an empty line.
function personalityBlurb(profile: BlindDateResponse["partnerProfile"]): string | null {
  if (profile.conflict_style) return `Handles conflict ${profile.conflict_style}.`;
  if (profile.emotional_openness) return `${profile.emotional_openness} with feelings.`;
  if (profile.treatment_of_others) return `${profile.treatment_of_others} with people.`;
  return null;
}

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

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Builds a minimal RFC-5545 calendar file so "Add to calendar" is a real
// action, with no external dependency — the whole event is assembled in the
// browser and downloaded as an .ics the user's calendar app can open.
function downloadIcs(blindDate: BlindDateResponse): void {
  const start = new Date(blindDate.dateTime);
  const end = new Date(start.getTime() + 90 * 60_000);
  const stamp = (d: Date) =>
    d
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "");
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Wingman//Blind Date//EN",
    "BEGIN:VEVENT",
    `UID:${crypto.randomUUID()}@wingman`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:Wingman date with ${blindDate.partnerName}`,
    `LOCATION:${blindDate.venue}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "wingman-date.ics";
  link.click();
  URL.revokeObjectURL(url);
}

const STATE_POLL_INTERVAL_MS = 5000;

export default function BlindDate() {
  const navigate = useNavigate();
  const [blindDate, setBlindDate] = useState<BlindDateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // True once followUpState flips to DATE_PASSED (#358) — swaps the calendar
  // button for the "How did it go?" debrief entrance instead of yanking the
  // user off the page mid-viewing.
  const [datePassed, setDatePassed] = useState(false);

  useEffect(() => {
    const userId = readStoredUserId();
    if (!userId) {
      navigate("/login", { replace: true });
      return;
    }

    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/users/${userId}/blind-date`);
        if (!res.ok) throw new Error("Could not load Blind Date details");
        const parsed = BlindDateResponseSchema.safeParse(await res.json());
        if (!parsed.success) throw new Error("Unexpected response from server");
        if (!cancelled) setBlindDate(parsed.data);
      } catch {
        if (!cancelled) setError("Could not load your Blind Date. Please try again later.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    // Watches for the date passing (#358): the follow-up resolver flips
    // followUpState to DATE_PASSED server-side, and this page — where the
    // user is most likely parked — must surface the debrief entrance itself,
    // since matchingState never leaves DATE_ASSIGNED here.
    async function pollFollowUp() {
      try {
        const res = await fetch(`/api/users/${userId}/state`);
        if (!res.ok || cancelled) return;
        const parsed = UserStateResponseSchema.safeParse(await res.json());
        if (parsed.success && !cancelled && parsed.data.followUpState === "DATE_PASSED") {
          setDatePassed(true);
          // DATE_PASSED is terminal for this page — the debrief CTA is up, so
          // keeping the poll alive would just burn /state requests.
          clearInterval(interval);
        }
      } catch {
        // Transient errors retry on the next tick.
      }
    }

    load();
    // The interval is created before the immediate poll's fetch can resolve,
    // so pollFollowUp's clearInterval always sees an initialized value.
    const interval = setInterval(pollFollowUp, STATE_POLL_INTERVAL_MS);
    pollFollowUp();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [navigate]);

  const firstName = blindDate?.partnerName.split(" ")[0] ?? "";
  const subline = blindDate
    ? [
        `${blindDate.partnerProfile.age}`,
        blindDate.partnerProfile.city,
        blindDate.partnerProfile.job,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const blurb = blindDate ? personalityBlurb(blindDate.partnerProfile) : null;

  return (
    <AppLayout>
      <div className="mx-auto flex min-h-[80vh] w-full max-w-sm flex-col px-8 pt-8">
        <div className="flex flex-1 flex-col">
          <div className="flex items-center gap-2">
            <span className="h-[7px] w-[7px] rounded-full bg-brand" />
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
              Confirmed
            </span>
          </div>
          <h1 className="mb-[22px] mt-3.5 text-[32px] font-bold tracking-[-0.03em] text-foreground">
            It's a date.
          </h1>

          {loading && <p className="text-sm text-muted-foreground">Loading your date…</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}

          {blindDate && (
            <div className="flex flex-col items-center gap-[18px] rounded-3xl border px-6 py-[26px]">
              <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-muted-foreground/60">
                Wingman
              </span>
              <div className="flex flex-col items-center gap-2">
                <HeartPhotos
                  selfUrl={blindDate.selfPhotoUrl}
                  partnerUrl={blindDate.partnerPhotoUrl}
                />
                <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
                  You + {firstName}
                </span>
              </div>
              <div className="h-px w-full bg-border" />
              <div className="flex flex-col items-center gap-1">
                <span className="text-2xl font-bold tracking-[-0.02em] text-foreground">
                  {blindDate.partnerName}
                </span>
                {subline && <span className="text-sm text-muted-foreground">{subline}</span>}
              </div>
              <div className="flex flex-col items-center gap-0.5 text-center">
                <span className="text-base font-semibold text-foreground">{blindDate.venue}</span>
                <span className="text-sm font-medium text-brand">
                  {formatDateTime(blindDate.dateTime)}
                </span>
              </div>
              {blurb && (
                <p className="text-center text-[13.5px] leading-normal text-muted-foreground">
                  {blurb}
                </p>
              )}
            </div>
          )}
        </div>
        {blindDate && (
          <div className="pb-12 pt-6">
            {datePassed ? (
              <button
                onClick={() => navigate("/debrief")}
                data-testid="debrief-cta"
                className="w-full rounded-[18px] bg-primary px-4 py-[18px] text-base font-semibold text-primary-foreground"
              >
                How did it go? Tell Barney →
              </button>
            ) : (
              <button
                onClick={() => downloadIcs(blindDate)}
                className="w-full rounded-[18px] bg-primary px-4 py-[18px] text-base font-semibold text-primary-foreground"
              >
                Add to calendar
              </button>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  );
}
