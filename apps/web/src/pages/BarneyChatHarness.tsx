import { useState } from "react";
import type { ChatMessage } from "@wingman/shared";
import BarneyChat from "@/components/BarneyChat";
import { Button } from "@/components/ui/button";

// Dev-only harness so BarneyChat can be exercised in isolation (alignment,
// send handling, loading/disabled states) before any real Barney mode wires it
// up. Mounted only under import.meta.env.DEV — see App.tsx.
const SEED: ChatMessage[] = [
  { role: "assistant", content: "Hey, I'm Barney. Tell me about yourself." },
  { role: "user", content: "I'm a rock climber who codes." },
];

export default function BarneyChatHarness() {
  const [messages, setMessages] = useState<ChatMessage[]>(SEED);
  const [loading, setLoading] = useState(false);
  const [disabled, setDisabled] = useState(false);

  function handleSend(text: string) {
    setMessages((prev) => [...prev, { role: "user", content: text }]);
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center gap-2 border-b p-2">
        <Button size="sm" variant="outline" onClick={() => setLoading((v) => !v)}>
          Toggle loading
        </Button>
        <Button size="sm" variant="outline" onClick={() => setDisabled((v) => !v)}>
          Toggle disabled
        </Button>
      </div>
      <div className="flex-1 overflow-hidden">
        <BarneyChat messages={messages} onSend={handleSend} loading={loading} disabled={disabled} />
      </div>
    </div>
  );
}
