import { useEffect, useState } from "react";
import { View } from "react-native";
import { useRouter } from "expo-router";
import { Lock } from "lucide-react-native";
import { StudentAuthInputSchema, UserResponseSchema } from "@wingman/shared";
import { AuthScreen } from "~/components/AuthScreen";
import { FormField } from "~/components/FormField";
import { Button } from "~/components/ui/button";
import { Text } from "~/components/ui/text";
import { ApiError, NetworkError, apiRequest } from "~/lib/api";
import { COLORS } from "~/lib/colors";
import { ROUTES } from "~/lib/routeForState";
import { loadUser } from "~/lib/session";
import { trackAction } from "~/lib/telemetry";

type FormData = {
  universityEmail: string;
  studentId: string;
  password: string;
};

type FieldErrors = Partial<Record<keyof FormData, string>>;

/**
 * "Verify Your University", ported from apps/web/src/pages/Authenticate.tsx.
 *
 * This step is not optional decoration: routeForState is fail-closed on
 * `universityVerified`, so until it completes the user cannot reach the
 * interview at all. The university-email rule lives in the shared schema, so
 * the same rejection happens here and on the server.
 */
export default function Verify() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [form, setForm] = useState<FormData>({
    universityEmail: "",
    studentId: "",
    password: "",
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void (async () => {
      const user = await loadUser();
      if (!user) {
        router.replace(ROUTES.login);
        return;
      }
      setUserId(user.id);
    })();
  }, [router]);

  function set(field: keyof FormData, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  async function handleSubmit() {
    // Emitted before validation, so an abandoned form that never reaches the
    // API is still visible in the funnel (#554) — that gap is the whole reason
    // client telemetry exists.
    trackAction("/verify", "verification_submitted");
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

    if (!userId) {
      setServerError("Please sign up first.");
      return;
    }

    setLoading(true);
    try {
      await apiRequest(`/api/users/${userId}/authenticate`, {
        method: "POST",
        body: result.data,
        schema: UserResponseSchema,
        fallbackErrorMessage: "Verification failed",
      });
      router.replace(ROUTES.verified);
    } catch (err) {
      if (err instanceof ApiError || err instanceof NetworkError) {
        setServerError(err.message);
      } else {
        setServerError("Unexpected response from server");
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthScreen
      title="Verify Your University"
      subtitle="Access is reserved for verified university students."
    >
      <FormField
        label="University Email"
        testID="verify-university-email"
        placeholder="you@mail.tau.ac.il"
        value={form.universityEmail}
        onChangeText={(value) => set("universityEmail", value)}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        error={errors.universityEmail}
      />
      <FormField
        label="Student ID Number"
        testID="verify-student-id"
        placeholder="e.g. 20241138"
        value={form.studentId}
        onChangeText={(value) => set("studentId", value)}
        keyboardType="number-pad"
        error={errors.studentId}
      />
      <FormField
        label="Password"
        testID="verify-password"
        placeholder="••••••••"
        value={form.password}
        onChangeText={(value) => set("password", value)}
        secureTextEntry
        autoCapitalize="none"
        error={errors.password}
      />

      {serverError && <Text className="text-destructive pl-1 text-sm">{serverError}</Text>}

      <Button
        className="mt-5 h-14 w-full rounded-[18px]"
        disabled={loading}
        onPress={() => void handleSubmit()}
        testID="verify-submit"
      >
        <Text className="text-base font-semibold">{loading ? "Verifying…" : "Verify"}</Text>
      </Button>

      <View className="bg-accent mt-7 flex-row items-start gap-3 rounded-2xl p-4">
        <Lock size={18} color={COLORS.brand} />
        <Text className="text-muted-foreground flex-1 text-[13px] leading-5">
          Verification keeps the community private and trusted. We never share your email with
          anyone.
        </Text>
      </View>
    </AuthScreen>
  );
}
