import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LoginInputSchema, UserResponseSchema, UserStateResponseSchema } from "@wingman/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { redirectPathForState } from "@/lib/redirectPathForState";
import { setTelemetryUser, trackAction } from "@/lib/telemetry";

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Emitted before validation, so an abandoned form that never reaches the
    // API is still visible in the funnel (#554).
    trackAction("/login", "login_submitted");
    setServerError(null);
    setEmailError(null);
    setPasswordError(null);

    const result = LoginInputSchema.safeParse({ email, password });
    if (!result.success) {
      for (const issue of result.error.issues) {
        if (issue.path[0] === "password") setPasswordError(issue.message);
        else setEmailError(issue.message);
      }
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result.data),
      });

      if (res.status === 404) {
        setServerError("No account found with that email.");
        return;
      }
      if (res.status === 401) {
        setServerError("Incorrect email or password.");
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const message = typeof body.error === "string" ? body.error : "Login failed";
        setServerError(message);
        return;
      }

      // Validate the response at the boundary before persisting, keeping the
      // localStorage contract consistent with registration (see Register.tsx).
      const parsed = UserResponseSchema.safeParse(await res.json());
      if (!parsed.success) {
        setServerError("Unexpected response from server");
        return;
      }
      localStorage.setItem("user", JSON.stringify(parsed.data));
      // Subsequent telemetry is attributed to this user (#554). Events already
      // queued keep the anonymous subject they were emitted under, so this
      // does not backfill a userId onto the pre-auth events that led here.
      setTelemetryUser(parsed.data.id);

      const stateRes = await fetch(`/api/users/${parsed.data.id}/state`);
      if (!stateRes.ok) {
        setServerError("Unexpected response from server");
        return;
      }
      const state = UserStateResponseSchema.safeParse(await stateRes.json());
      if (!state.success) {
        setServerError("Unexpected response from server");
        return;
      }
      navigate(redirectPathForState(state.data));
    } catch {
      setServerError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-semibold text-primary">Welcome back</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-1">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setEmailError(null);
              }}
            />
            {emailError && <p className="text-sm text-destructive">{emailError}</p>}
          </div>

          <div className="space-y-1">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="Your password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setPasswordError(null);
              }}
            />
            {passwordError && <p className="text-sm text-destructive">{passwordError}</p>}
          </div>

          {serverError && <p className="text-sm text-destructive text-center">{serverError}</p>}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Logging in…" : "Log in"}
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
        </form>
      </div>
    </div>
  );
}
