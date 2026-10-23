import { useNavigate } from "react-router-dom";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";

// Success confirmation shown right after the university-verification step —
// Continue drops the user straight into the Phase 1 interview chat (#327; the
// Concierge intro screen that used to sit between them was removed).
export default function Verified() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex min-h-screen w-full max-w-sm flex-col px-8">
        <div className="flex flex-1 flex-col items-center justify-center gap-7">
          <div className="flex h-[92px] w-[92px] items-center justify-center rounded-full border-[1.5px] border-brand">
            <Check className="h-11 w-11 text-brand" strokeWidth={1.6} />
          </div>
          <div className="flex flex-col items-center gap-2.5">
            <span className="text-[32px] font-bold tracking-[-0.03em] text-foreground">
              You're Verified
            </span>
            <span className="text-base text-muted-foreground">Welcome to Wingman.</span>
          </div>
        </div>
        <div className="pb-12">
          <Button
            className="h-14 w-full rounded-[18px] text-base font-semibold"
            onClick={() => navigate("/barney/phase1")}
          >
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
