import { TextInput, View, type TextInputProps } from "react-native";
import { Text } from "~/components/ui/text";
import { COLORS } from "~/lib/colors";
import { cn } from "~/lib/utils";

/**
 * A labelled text field for the onboarding forms.
 *
 * Deliberately not the react-native-reusables `Input`: these screens follow the
 * onboarding mockup the web pages already implement (tall pill fields, a static
 * label above rather than a placeholder standing in for one, the error sitting
 * directly under the field). Wrapping the shared primitive to reach that shape
 * would mean overriding almost every class it sets.
 */
export function FormField({
  label,
  error,
  className,
  ...props
}: TextInputProps & { label: string; error?: string }) {
  return (
    <View className="gap-2.5">
      <Text className="text-muted-foreground pl-1 text-[13px] font-medium">{label}</Text>
      <TextInput
        placeholderTextColor={COLORS.mutedForeground}
        className={cn(
          "border-border bg-background text-foreground w-full rounded-[18px] border px-[18px] py-[18px] text-base",
          // The teal focus ring the web fields use has no RN equivalent
          // (there is no :focus selector), so the error state is what changes
          // the border here.
          error && "border-destructive",
          className
        )}
        {...props}
      />
      {error && <Text className="text-destructive pl-1 text-sm">{error}</Text>}
    </View>
  );
}
