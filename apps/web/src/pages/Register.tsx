import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { RegisterInputSchema, UserResponseSchema } from "@wingman/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { setTelemetryUser, trackAction } from "@/lib/telemetry";

type FormData = {
  name: string;
  email: string;
  phone: string;
  gender: string;
  password: string;
};

type FieldErrors = Partial<Record<keyof FormData, string>>;

export default function Register() {
  const navigate = useNavigate();
  const location = useLocation();
  // Router state or a ?email= query can pre-fill the form — used by tests and
  // by anything that already knows who is signing up.
  const prefill = (location.state ?? {}) as { email?: string; name?: string };
  const initialEmail = prefill.email ?? new URLSearchParams(location.search).get("email") ?? "";
  const [form, setForm] = useState<FormData>({
    name: prefill.name ?? "",
    email: initialEmail,
    phone: "",
    gender: "",
    password: "",
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function set(field: keyof FormData, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Emitted before validation, so an abandoned form that never reaches the
    // API is still visible in the funnel (#554).
    trackAction("/register", "register_submitted");
    setServerError(null);

    const result = RegisterInputSchema.safeParse(form);
    if (!result.success) {
      const fieldErrors: FieldErrors = {};
      for (const issue of result.error.issues) {
        const key = issue.path[0] as keyof FormData;
        fieldErrors[key] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result.data),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // The 400 path returns an array of Zod issues; only render strings so
        // the user never sees "[object Object]".
        const message = typeof body.error === "string" ? body.error : "Registration failed";
        setServerError(message);
        return;
      }

      // Validate the response at the boundary before persisting, keeping the
      // localStorage contract consistent for the downstream /barney consumer.
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
      // After sign-up, prove current-student status on the "Verify Your
      // University" step before entering the interview (#275).
      navigate("/authenticate");
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
          <h1 className="text-3xl font-bold tracking-[-0.03em] text-foreground">
            Sign up for Wingman
          </h1>
          <p className="mt-3 text-base text-muted-foreground">
            Wingman finds the person. You just show up.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-5">
          <div className="space-y-1">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              placeholder="Your name"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
            />
            {errors.name && <p className="text-sm text-destructive">{errors.name}</p>}
          </div>

          <div className="space-y-1">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
            />
            {errors.email && <p className="text-sm text-destructive">{errors.email}</p>}
          </div>

          <div className="space-y-1">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="At least 8 characters"
              value={form.password}
              onChange={(e) => set("password", e.target.value)}
            />
            {errors.password && <p className="text-sm text-destructive">{errors.password}</p>}
          </div>

          <div className="space-y-1">
            <Label htmlFor="phone">Phone</Label>
            <Input
              id="phone"
              type="tel"
              placeholder="+1 555 000 0000"
              value={form.phone}
              onChange={(e) => set("phone", e.target.value)}
            />
            {errors.phone && <p className="text-sm text-destructive">{errors.phone}</p>}
          </div>

          <div className="space-y-2">
            <Label>Gender</Label>
            <RadioGroup
              value={form.gender}
              onValueChange={(v) => set("gender", v)}
              className="flex gap-4"
            >
              {["male", "female", "other"].map((g) => (
                <div key={g} className="flex items-center gap-1.5">
                  <RadioGroupItem value={g} id={`gender-${g}`} />
                  <Label htmlFor={`gender-${g}`} className="capitalize cursor-pointer">
                    {g}
                  </Label>
                </div>
              ))}
            </RadioGroup>
            {errors.gender && <p className="text-sm text-destructive">{errors.gender}</p>}
          </div>

          {serverError && <p className="text-sm text-destructive text-center">{serverError}</p>}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Creating account…" : "Get started"}
          </Button>
        </form>
      </div>
    </div>
  );
}
