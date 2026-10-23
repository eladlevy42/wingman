import { useState } from "react";
import { Pressable, View } from "react-native";
import { Link, useRouter } from "expo-router";
import { GenderSchema, RegisterInputSchema, UserResponseSchema } from "@wingman/shared";
import { AuthScreen } from "~/components/AuthScreen";
import { FormField } from "~/components/FormField";
import { Button } from "~/components/ui/button";
import { Text } from "~/components/ui/text";
import { ApiError, NetworkError, apiRequest } from "~/lib/api";
import { ROUTES } from "~/lib/routeForState";
import { saveUser } from "~/lib/session";
import { cn } from "~/lib/utils";
import { trackAction } from "~/lib/telemetry";

type FormData = {
  name: string;
  email: string;
  phone: string;
  gender: string;
  password: string;
};

type FieldErrors = Partial<Record<keyof FormData, string>>;

const GENDER_LABELS: Record<string, string> = {
  male: "Male",
  female: "Female",
  other: "Other",
};

/**
 * Sign-up, ported from apps/web/src/pages/Register.tsx.
 *
 * Email and password is the only way in, on both clients — the Google and
 * Microsoft buttons web used to carry were removed with Firebase (#512), so
 * there is no longer a gap here to explain.
 */
export default function Register() {
  const router = useRouter();
  const [form, setForm] = useState<FormData>({
    name: "",
    email: "",
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

  async function handleSubmit() {
    // Emitted before validation, so an abandoned form that never reaches the
    // API is still visible in the funnel (#554) — that gap is the whole reason
    // client telemetry exists.
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
      const user = await apiRequest("/api/auth/register", {
        method: "POST",
        body: result.data,
        schema: UserResponseSchema,
        fallbackErrorMessage: "Registration failed",
      });
      await saveUser(user);
      // After sign-up, prove current-student status on the "Verify Your
      // University" step before entering the interview.
      router.replace(ROUTES.verify);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setErrors({ email: "That email is already registered." });
      } else if (err instanceof ApiError || err instanceof NetworkError) {
        setServerError(err.message);
      } else {
        setServerError("Unexpected response from server");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthScreen title="Create your account" subtitle="Wingman finds the person. You just show up.">
      <FormField
        label="Name"
        testID="register-name"
        placeholder="Your name"
        value={form.name}
        onChangeText={(value) => set("name", value)}
        autoCapitalize="words"
        autoComplete="name"
        error={errors.name}
      />
      <FormField
        label="Email"
        testID="register-email"
        placeholder="you@example.com"
        value={form.email}
        onChangeText={(value) => set("email", value)}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        autoComplete="email"
        error={errors.email}
      />
      <FormField
        label="Phone"
        testID="register-phone"
        placeholder="050 000 0000"
        value={form.phone}
        onChangeText={(value) => set("phone", value)}
        keyboardType="phone-pad"
        autoComplete="tel"
        error={errors.phone}
      />

      <View className="gap-2.5">
        <Text className="text-muted-foreground pl-1 text-[13px] font-medium">Gender</Text>
        <View className="flex-row gap-2">
          {GenderSchema.options.map((option) => {
            const selected = form.gender === option;
            return (
              <Pressable
                key={option}
                onPress={() => set("gender", option)}
                testID={`register-gender-${option}`}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                className={cn(
                  "flex-1 items-center rounded-[18px] border py-3.5",
                  selected ? "border-brand bg-brand/10" : "border-border bg-background"
                )}
              >
                <Text
                  className={cn(
                    "text-base",
                    selected ? "text-foreground font-semibold" : "text-muted-foreground"
                  )}
                >
                  {GENDER_LABELS[option]}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {errors.gender && <Text className="text-destructive pl-1 text-sm">{errors.gender}</Text>}
      </View>

      <FormField
        label="Password"
        testID="register-password"
        placeholder="At least 8 characters"
        value={form.password}
        onChangeText={(value) => set("password", value)}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="new-password"
        error={errors.password}
      />

      {serverError && <Text className="text-destructive pl-1 text-sm">{serverError}</Text>}

      <Button
        className="mt-5 h-14 w-full rounded-[18px]"
        disabled={loading}
        onPress={() => void handleSubmit()}
        testID="register-submit"
      >
        <Text className="text-base font-semibold">{loading ? "Creating…" : "Create account"}</Text>
      </Button>

      <View className="mt-2 flex-row justify-center gap-1">
        <Text className="text-muted-foreground text-sm">Already have an account?</Text>
        <Link href={ROUTES.login} replace asChild>
          <Pressable accessibilityRole="link">
            <Text className="text-foreground text-sm font-semibold">Sign in</Text>
          </Pressable>
        </Link>
      </View>
    </AuthScreen>
  );
}
