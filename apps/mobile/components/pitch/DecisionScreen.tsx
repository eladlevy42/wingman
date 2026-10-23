import { Image, View } from "react-native";
import { Button } from "~/components/ui/button";
import { Text } from "~/components/ui/text";
import type { Decision } from "~/lib/decision";

interface DecisionScreenProps {
  matchPhotoUrl: string | null;
  partnerName: string | null;
  education: string | null;
  decisionError: string | null;
  decisionPending: boolean;
  onDecide: (decision: Decision) => void;
}

/**
 * The Yeah/Nah screen (#464) — mobile counterpart of web's
 * `components/pitch/DecisionScreen`.
 *
 * The one place the photo is shown. The pitch is blind up to here: the reveal
 * gave a name and an education, the mechanic gave three answers, and this is
 * where the user finally sees who it is and decides on the whole of it.
 *
 * The photo is optional and its absence is not an error state — the api answers
 * a null photoUrl rather than failing when the partner never uploaded one, so
 * the decision goes ahead without it rather than being blocked by it.
 */
export default function DecisionScreen({
  matchPhotoUrl,
  partnerName,
  education,
  decisionError,
  decisionPending,
  onDecide,
}: DecisionScreenProps) {
  return (
    <View className="flex-1 px-8">
      <View className="flex-1 justify-center gap-6 py-8">
        <View className="flex-row items-center gap-2">
          <View className="bg-brand h-[7px] w-[7px] rounded-full" />
          <Text className="text-muted-foreground text-xs uppercase tracking-[1.2px]">
            The Introduction
          </Text>
        </View>

        {matchPhotoUrl !== null && (
          <Image
            source={{ uri: matchPhotoUrl }}
            accessibilityLabel="Your match"
            className="h-40 w-40 rounded-3xl"
            resizeMode="cover"
          />
        )}

        <View className="gap-1.5">
          <Text className="text-foreground text-[34px] font-bold leading-10 tracking-[-1.02px]">
            Is {partnerName ?? "this"}
            {"\n"}your kind of person?
          </Text>
          <Text className="text-muted-foreground mt-2 text-[15px] leading-6">
            {education !== null ? `${education}. ` : ""}Barney picked them just for you — trust your
            gut.
          </Text>
        </View>

        {decisionError !== null && (
          <Text className="text-destructive text-sm" testID="decision-error">
            {decisionError}
          </Text>
        )}
      </View>

      <View className="flex-row gap-3 pb-12">
        <Button
          variant="outline"
          className="h-14 flex-1 rounded-[18px]"
          disabled={decisionPending}
          onPress={() => onDecide("nah")}
          testID="decide-nah"
        >
          <Text className="text-base font-semibold">Neh</Text>
        </Button>
        <Button
          className="h-14 flex-1 rounded-[18px]"
          disabled={decisionPending}
          onPress={() => onDecide("yeah")}
          testID="decide-yeah"
        >
          <Text className="text-base font-semibold">Yeah</Text>
        </Button>
      </View>
    </View>
  );
}
