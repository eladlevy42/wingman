import { View } from "react-native";
import RadarPulse from "~/components/RadarPulse";
import { Text } from "~/components/ui/text";

interface PendingStateProps {
  title: string;
  body: string;
}

/**
 * "Waiting on the other person" — the shape the match flow lands in three
 * separate times (#464, #465).
 *
 * After yeah, until the other side answers. After the proposer forwards their
 * times, until the chooser picks. And on the chooser's screen, until the
 * proposer has picked at all. Web writes this layout twice — once as
 * `pitch/PendingState` and once as a local `Pending` inside ChooseTimes — with
 * the copy as the only difference between them, so mobile takes the copy as
 * props and keeps one.
 *
 * Wears the waiting screen's radar pulse for the same reason it does: nothing
 * here can be hurried, and the promise is that something is happening and the
 * user will be told.
 */
export default function PendingState({ title, body }: PendingStateProps) {
  return (
    <View className="flex-1 items-center justify-center gap-9 px-8">
      <RadarPulse />

      <View className="items-center gap-3">
        <Text className="text-foreground text-center text-[30px] font-bold tracking-[-0.9px]">
          {title}
        </Text>
        <Text className="text-muted-foreground max-w-[270px] text-center text-[15px] leading-6">
          {body}
        </Text>
      </View>

      <View className="flex-row items-center gap-2">
        <View className="bg-brand h-[7px] w-[7px] rounded-full" />
        <Text className="text-muted-foreground text-xs uppercase tracking-[1.2px]">Pending</Text>
      </View>
    </View>
  );
}
