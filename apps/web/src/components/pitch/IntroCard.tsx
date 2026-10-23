import AppLayout from "@/components/AppLayout";

interface IntroCardProps {
  partnerName: string | null;
  education: string | null;
  totalQuestions: number;
  onSendWish: () => void;
  onMaybeLater: () => void;
}

// The "Introducing…" reveal card (ADR-0022) is the pitch's opening screen: it
// names the match and shows their education, then leads into the 3-question
// genie chat ("Send a wish") or straight to the decision ("Maybe later").
export default function IntroCard({
  partnerName,
  education,
  totalQuestions,
  onSendWish,
  onMaybeLater,
}: IntroCardProps) {
  return (
    <AppLayout>
      <div className="mx-auto flex min-h-[80vh] w-full max-w-sm flex-col">
        <div className="flex flex-1 flex-col px-8 pt-8">
          <div className="flex items-center gap-2">
            <span className="h-[7px] w-[7px] rounded-full bg-brand" />
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
              Introducing
            </span>
          </div>
          <h1 className="mt-4 text-[32px] font-bold tracking-[-0.03em] text-foreground">
            {partnerName ?? "Your match"}
          </h1>
          {education && <span className="mt-1 text-[15px] text-muted-foreground">{education}</span>}
          <p className="mt-[22px] text-[15.5px] leading-relaxed text-foreground">
            Barney picked them just for you. Ask up to {totalQuestions} questions before you decide
            — or trust your gut.
          </p>
          <div className="mt-8 flex items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
              Your Genie Wish
            </span>
          </div>
          <div className="mt-4 flex w-full items-center rounded-[18px] border px-[18px] py-[18px]">
            <span className="mr-2 inline-block h-5 w-0.5 bg-brand" />
            <span className="text-[15px] text-muted-foreground/50">
              Ask {partnerName ?? "your match"} anything…
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-3 px-8 pb-12 pt-6">
          <button
            onClick={onSendWish}
            className="h-14 w-full rounded-[18px] bg-primary text-base font-semibold text-primary-foreground"
          >
            Send a wish
          </button>
          <button
            onClick={onMaybeLater}
            className="w-full py-1.5 text-center text-[15px] font-medium text-muted-foreground"
          >
            Maybe later
          </button>
        </div>
      </div>
    </AppLayout>
  );
}
