import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";

// Welcome screen — matches design screen 02: a top-aligned hero headline and
// description, with the primary/secondary actions pinned near the bottom and a
// small terms line beneath. Rendered in a phone-width column so the vertical
// rhythm mirrors the mockup.
export default function Landing() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex min-h-screen w-full max-w-sm flex-col px-8">
        <div className="flex flex-1 flex-col pt-24">
          <h1 className="text-[34px] font-bold leading-[1.15] tracking-[-0.035em] text-foreground">
            Exclusive
            <br />
            Connections.
            <br />
            Built for Students.
          </h1>
          <p className="mt-6 max-w-[300px] text-base leading-relaxed text-muted-foreground">
            Connect through your university community in a more meaningful way.
          </p>
        </div>

        <div className="flex flex-col gap-3 pb-10">
          <Button
            className="h-14 w-full rounded-[18px] text-base font-semibold"
            onClick={() => navigate("/register")}
          >
            Sign Up
          </Button>
          <Button
            variant="outline"
            className="h-14 w-full rounded-[18px] text-base font-medium"
            onClick={() => navigate("/login")}
          >
            Log In
          </Button>
          <p className="mt-2 text-center text-[11px] leading-relaxed text-muted-foreground/70">
            By continuing you agree to our{" "}
            <a href="#" className="text-muted-foreground underline-offset-2 hover:underline">
              Terms
            </a>{" "}
            and{" "}
            <a href="#" className="text-muted-foreground underline-offset-2 hover:underline">
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
