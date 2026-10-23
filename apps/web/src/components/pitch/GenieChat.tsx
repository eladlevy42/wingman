import type { ChatMessage } from "@wingman/shared";
import { Sparkles } from "lucide-react";
import AppLayout from "@/components/AppLayout";
import BarneyChat from "@/components/BarneyChat";

interface GenieChatProps {
  totalQuestions: number;
  questionsLeft: number;
  messages: ChatMessage[];
  loading: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onSeeWhoItIs: () => void;
}

// The 3-question genie chat: the user has up to `totalQuestions` questions to
// ask Barney about their match before deciding, or they can find out for
// themselves once the count runs out.
export default function GenieChat({
  totalQuestions,
  questionsLeft,
  messages,
  loading,
  disabled,
  onSend,
  onSeeWhoItIs,
}: GenieChatProps) {
  return (
    <AppLayout>
      <div className="flex h-full flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-4 sm:px-6">
          <h1 className="max-w-[60ch] text-lg font-semibold text-foreground">
            Just like a genie — you have {totalQuestions} questions to ask Barney about your match,
            or you will find out yourself.
          </h1>
          {questionsLeft > 0 && (
            <div
              className="flex shrink-0 items-center gap-3"
              aria-label={`${questionsLeft} ${questionsLeft === 1 ? "wish" : "wishes"} left`}
            >
              <div className="flex flex-col items-end">
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  Wishes
                </span>
                <div className="mt-1 flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <Sparkles
                      key={i}
                      className={`h-4 w-4 transition-all duration-300 ${
                        i < questionsLeft
                          ? "scale-100 text-brand"
                          : "scale-90 text-muted-foreground/25"
                      }`}
                      fill={i < questionsLeft ? "currentColor" : "none"}
                    />
                  ))}
                </div>
              </div>
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-brand/10 text-xl font-bold text-brand ring-1 ring-brand/20">
                {questionsLeft}
              </div>
            </div>
          )}
        </header>
        <BarneyChat messages={messages} onSend={onSend} loading={loading} disabled={disabled} />
        {questionsLeft <= 0 && !loading && (
          <div className="border-t border-border px-4 py-4 sm:px-6">
            <button
              onClick={onSeeWhoItIs}
              className="w-full rounded-[18px] bg-primary px-4 py-[18px] text-base font-semibold text-primary-foreground"
            >
              See who it is
            </button>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
