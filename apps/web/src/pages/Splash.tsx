import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";

// The app's first screen: the Wingman splash. "Get Started" leads into the
// welcome screen and the real sign-up / login flow.
export default function Splash() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex min-h-screen w-full max-w-sm flex-col px-8">
        <div className="flex flex-1 flex-col items-center justify-center">
          <span className="text-[46px] font-bold tracking-[-0.04em] text-foreground">Wingman</span>
          <span className="mt-[18px] h-1 w-12 rounded-full bg-brand" />
        </div>
        <div className="pb-12">
          <Button
            className="h-14 w-full rounded-[18px] text-base font-semibold"
            onClick={() => navigate("/welcome")}
          >
            Get Started
          </Button>
        </div>
      </div>
    </div>
  );
}
