import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Lock } from "lucide-react";
import { StudentAuthInputSchema, UserResponseSchema } from "@wingman/shared";
import { Button } from "@/components/ui/button";
import { trackAction } from "@/lib/telemetry";

// The "Verify Your University" step (#275), reached right after sign-up. Matches
// the onboarding mockup (Verify.tsx) but is fully wired: the university email is
// gated to a recognised university (Tel Aviv University for now), the student id
// is captured, and the password becomes the login credential. On success the
// user continues into the interview.

type FormData = {
  universityEmail: string;
  studentId: string;
  password: string;
};

type FieldErrors = Partial<Record<keyof FormData, string>>;

function readUserId(): string | null {
  try {
    const stored = localStorage.getItem("user");
    if (!stored) return null;
    const parsed = UserResponseSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data.id : null;
  } catch {
    return null;
  }
}

export default function Authenticate() {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormData>({
    universityEmail: "",
    studentId: "",
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
    trackAction("/authenticate", "verification_submitted");
    setServerError(null);

    const result = StudentAuthInputSchema.safeParse(form);
    if (!result.success) {
      const fieldErrors: FieldErrors = {};
      for (const issue of result.error.issues) {
        const key = issue.path[0] as keyof FormData;
        fieldErrors[key] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }

    const userId = readUserId();
    if (!userId) {
      setServerError("Please sign up first.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/users/${userId}/authenticate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result.data),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // The 400 path returns an array of Zod issues; only render strings so the
        // user never sees "[object Object]".
        const message = typeof body.error === "string" ? body.error : "Verification failed";
        setServerError(message);
        return;
      }

      // Success → the "You're verified" confirmation, then straight into the
      // Phase 1 interview (#327).
      navigate("/verified");
    } catch {
      setServerError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex min-h-screen w-full max-w-sm flex-col px-8 pt-[68px]">
        <h1 className="text-[30px] font-bold tracking-[-0.03em] text-foreground">
          Verify Your University
        </h1>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">
          Access is reserved for verified university students.
        </p>

        <form onSubmit={handleSubmit} className="mt-10 flex flex-col gap-3.5">
          <Field
            label="University Email"
            type="email"
            placeholder="you@mail.tau.ac.il"
            value={form.universityEmail}
            onChange={(v) => set("universityEmail", v)}
            error={errors.universityEmail}
          />
          <Field
            label="Student ID Number"
            placeholder="e.g. 20241138"
            value={form.studentId}
            onChange={(v) => set("studentId", v)}
            error={errors.studentId}
          />
          <Field
            label="Password"
            type="password"
            placeholder="••••••••"
            value={form.password}
            onChange={(v) => set("password", v)}
            error={errors.password}
          />

          {serverError && <p className="pl-1 text-sm text-destructive">{serverError}</p>}

          <Button
            type="submit"
            disabled={loading}
            className="mt-5 h-14 w-full rounded-[18px] text-base font-semibold"
          >
            {loading ? "Verifying…" : "Verify"}
          </Button>
        </form>

        <div className="mt-7 flex items-start gap-3 rounded-2xl bg-accent p-4">
          <Lock className="mt-0.5 h-[18px] w-[18px] shrink-0 text-brand" />
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Verification keeps the community private and trusted. We never share your email with
            anyone.
          </p>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  type = "text",
  placeholder,
  value,
  onChange,
  error,
}: {
  label: string;
  type?: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  // Derive a stable id from the label so the <label> is programmatically
  // associated with its input (accessibility + testability).
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <div className="flex flex-col gap-2.5">
      <label htmlFor={id} className="pl-1 text-[13px] font-medium text-muted-foreground">
        {label}
      </label>
      <input
        id={id}
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex w-full items-center rounded-[18px] border bg-background px-[18px] py-[18px] text-base text-foreground outline-none placeholder:text-muted-foreground/50 focus:border-brand"
      />
      {error && <p className="pl-1 text-sm text-destructive">{error}</p>}
    </div>
  );
}
