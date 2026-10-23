import { useEffect, useState } from "react";
import { MatchPhotoResponseSchema } from "@wingman/shared";
import { apiRequest } from "~/lib/api";

export interface PitchSession {
  partnerName: string | null;
  education: string | null;
  /**
   * The match-gated photo. Nothing on the reveal card renders it — ADR-0022
   * puts name and education on the card and holds the photo back for the
   * decision screen (#464). It is loaded here anyway because it arrives in the
   * same response, and the decision screen should not pay for a second
   * round-trip to show it.
   */
  matchPhotoUrl: string | null;
  /** False until the reveal fetch has settled, either way. */
  loaded: boolean;
}

/**
 * Loads the match reveal for the pitch screen (ADR-0022).
 *
 * Every field of MatchPhotoResponse is nullable by design: the api's
 * getMatchPhoto answers `photoUrl: null` rather than erroring precisely so a
 * missing photo cannot block the decision, and partnerName/education default to
 * null for a user with no current match. So a failed or empty fetch is not an
 * error state here — it is the degraded card, which still names the match as
 * "Your match" and still lets the user act. There is deliberately no error
 * return: the one thing this screen must never do is strand a matched user in
 * front of a retry button when the flow could have carried on without the photo.
 *
 * The reveal only. The `matchId` the pitch session needs comes from the route
 * guard, which already read `/state` to decide whether this user belongs here
 * (#464) — this hook briefly fetched it a second time, which is a round-trip
 * for a field the screen was handed and threw away.
 */
export function usePitchSession(userId: string | null): PitchSession {
  const [partnerName, setPartnerName] = useState<string | null>(null);
  const [education, setEducation] = useState<string | null>(null);
  const [matchPhotoUrl, setMatchPhotoUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;

    void (async () => {
      try {
        const reveal = await apiRequest(`/api/users/${userId}/match-photo`, {
          schema: MatchPhotoResponseSchema,
        });
        if (cancelled) return;
        setPartnerName(reveal.partnerName);
        setEducation(reveal.education);
        setMatchPhotoUrl(reveal.photoUrl);
      } catch {
        // Degrade rather than fail — see the note above.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  return { partnerName, education, matchPhotoUrl, loaded };
}
