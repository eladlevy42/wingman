import AppLayout from "@/components/AppLayout";

// Shown once the user has decided "yeah" while the other user catches up —
// Pitch.tsx's poll effect moves the page on once the other side responds.
export default function PendingState() {
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
          <span className="text-[30px] font-bold tracking-[-0.03em] text-foreground">
            You said yeah.
          </span>
          <span className="max-w-[270px] text-[15px] leading-relaxed text-muted-foreground">
            We'll let you know the moment your match says yeah too — then you'll pick a time
            together.
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
