import { usePitchSession } from "@/hooks/usePitchSession";
import { usePitchDecision } from "@/hooks/usePitchDecision";
import IntroCard from "@/components/pitch/IntroCard";
import GenieChat from "@/components/pitch/GenieChat";
import DecisionScreen from "@/components/pitch/DecisionScreen";
import PendingState from "@/components/pitch/PendingState";

export default function Pitch() {
  const {
    totalQuestions,
    messages,
    loading,
    initFailed,
    questionsLeft,
    matchPhotoUrl,
    showIntro,
    setShowIntro,
    partnerName,
    education,
    handleSend,
    matchIdRef,
    userIdRef,
  } = usePitchSession();

  const {
    showDecision,
    setShowDecision,
    decisionMade,
    chosenDecision,
    decisionPending,
    decisionError,
    handleDecision,
  } = usePitchDecision(matchIdRef, userIdRef);

  // Once the user has decided "yeah", hold on a pending screen while the other
  // user catches up (usePitchDecision's poll effect moves us on).
  if (decisionMade && chosenDecision === "yeah") {
    return <PendingState />;
  }

  // The decision screen (design screen 11) takes over once the user taps through
  // from the final answer — the blind pitch is done, so it's a gut call on the
  // reveal photo. Gated on showDecision (not questionsLeft) so Barney's answer to
  // the 3rd question stays on screen until the user chooses to proceed.
  if (showDecision && !initFailed) {
    return (
      <DecisionScreen
        matchPhotoUrl={matchPhotoUrl}
        partnerName={partnerName}
        education={education}
        decisionError={decisionError}
        decisionPending={decisionPending}
        onDecide={handleDecision}
      />
    );
  }

  // The "Introducing…" reveal card (ADR-0022) is the pitch's opening screen: it
  // names the match and shows their education, then leads into the 3-question
  // genie chat ("Send a wish") or straight to the decision ("Maybe later").
  if (showIntro && !initFailed) {
    return (
      <IntroCard
        partnerName={partnerName}
        education={education}
        totalQuestions={totalQuestions}
        onSendWish={() => setShowIntro(false)}
        onMaybeLater={() => {
          setShowIntro(false);
          setShowDecision(true);
        }}
      />
    );
  }

  return (
    <GenieChat
      totalQuestions={totalQuestions}
      questionsLeft={questionsLeft}
      messages={messages}
      loading={loading}
      disabled={initFailed || questionsLeft <= 0}
      onSend={handleSend}
      onSeeWhoItIs={() => setShowDecision(true)}
    />
  );
}
