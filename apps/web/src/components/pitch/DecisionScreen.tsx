import AppLayout from "@/components/AppLayout";

interface DecisionScreenProps {
  matchPhotoUrl: string | null;
  partnerName: string | null;
  education: string | null;
  decisionError: string | null;
  decisionPending: boolean;
  onDecide: (decision: "yeah" | "nah") => void;
}

// The decision screen (design screen 11) takes over once the user taps through
// from the final answer — the blind pitch is done, so it's a gut call on the
// reveal photo.
export default function DecisionScreen({
  matchPhotoUrl,
  partnerName,
  education,
  decisionError,
  decisionPending,
  onDecide,
}: DecisionScreenProps) {
  return (
    <AppLayout>
      <div className="mx-auto flex min-h-[80vh] w-full max-w-sm flex-col px-8">
        <div className="flex flex-1 flex-col justify-center gap-6 py-8">
          <div className="flex items-center gap-2">
            <span className="h-[7px] w-[7px] rounded-full bg-brand" />
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
              The Introduction
            </span>
          </div>
          {matchPhotoUrl && (
            <img
              src={matchPhotoUrl}
              alt="Your match"
              className="h-40 w-40 rounded-3xl object-cover"
            />
          )}
          <div className="flex flex-col gap-1.5">
            <span className="text-[34px] font-bold leading-tight tracking-[-0.03em] text-foreground">
              Is {partnerName ?? "this"}
              <br />
              your kind of person?
            </span>
            <span className="mt-2 text-[15.5px] leading-relaxed text-muted-foreground">
              {education ? `${education}. ` : ""}Barney picked them just for you — trust your gut.
            </span>
          </div>
          {decisionError && <p className="text-sm text-destructive">{decisionError}</p>}
        </div>
        <div className="flex gap-3 pb-12">
          <button
            disabled={decisionPending}
            onClick={() => onDecide("nah")}
            className="flex-1 rounded-[18px] border bg-background px-4 py-[18px] text-base font-semibold text-foreground disabled:opacity-50"
          >
            Neh
          </button>
          <button
            disabled={decisionPending}
            onClick={() => onDecide("yeah")}
            className="flex-1 rounded-[18px] bg-primary px-4 py-[18px] text-base font-semibold text-primary-foreground disabled:opacity-50"
          >
            Yeah
          </button>
        </div>
      </div>
    </AppLayout>
  );
}
