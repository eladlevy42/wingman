import { useState } from "react";
import { Pressable, View } from "react-native";
import { Link, useRouter } from "expo-router";
import { LoginInputSchema, UserResponseSchema, UserStateResponseSchema } from "@wingman/shared";
import { AuthScreen } from "~/components/AuthScreen";
import { FormField } from "~/components/FormField";
import { Button } from "~/components/ui/button";
import { Text } from "~/components/ui/text";
import { ApiError, NetworkError, apiRequest } from "~/lib/api";
import { ROUTES, routeForState } from "~/lib/routeForState";
import { saveUser } from "~/lib/session";
import { trackAction } from "~/lib/telemetry";

/**
 * Sign-in, ported from apps/web/src/pages/Login.tsx.
 *
 * On success it asks the api where this user belongs rather than assuming the
 * interview — someone who already finished Phase 1 must not be sent back
 * through it. Social sign-in is omitted for the same reason as on Register.
 */
export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const [passwordError, setPasswordError] = useState<string | undefined>(undefined);
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    // Emitted before validation, so an abandoned form that never reaches the
    // API is still visible in the funnel (#554) — that gap is the whole reason
    // client telemetry exists.
    trackAction("/login", "login_submitted");
    setServerError(null);
    setEmailError(undefined);
    setPasswordError(undefined);

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
      const user = await apiRequest("/api/auth/login", {
        method: "POST",
        body: result.data,
        schema: UserResponseSchema,
        fallbackErrorMessage: "Login failed",
      });
      await saveUser(user);

      const state = await apiRequest(`/api/users/${user.id}/state`, {
        schema: UserStateResponseSchema,
      });
      router.replace(routeForState(state));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setServerError("No account found with that email.");
      } else if (err instanceof ApiError && err.status === 401) {
        setServerError("Incorrect email or password.");
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
    <AuthScreen title="Welcome back" subtitle="Sign in to pick up where you left off.">
      <FormField
        label="Email"
        placeholder="you@example.com"
        value={email}
        onChangeText={(value) => {
          setEmail(value);
          setEmailError(undefined);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        autoComplete="email"
        error={emailError}
      />
      <FormField
        label="Password"
        placeholder="••••••••"
        value={password}
        onChangeText={(value) => {
          setPassword(value);
          setPasswordError(undefined);
        }}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="current-password"
        error={passwordError}
      />

      {serverError && <Text className="text-destructive pl-1 text-sm">{serverError}</Text>}

      <Button
        className="mt-5 h-14 w-full rounded-[18px]"
        disabled={loading}
        onPress={() => void handleSubmit()}
      >
        <Text className="text-base font-semibold">{loading ? "Signing in…" : "Sign in"}</Text>
      </Button>

      <View className="mt-2 flex-row justify-center gap-1">
        <Text className="text-muted-foreground text-sm">New here?</Text>
        <Link href={ROUTES.register} replace asChild>
          <Pressable accessibilityRole="link">
            <Text className="text-foreground text-sm font-semibold">Create an account</Text>
          </Pressable>
        </Link>
      </View>
    </AuthScreen>
  );
}
