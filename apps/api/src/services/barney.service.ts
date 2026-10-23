// Public entry point for the Barney chat/interview session lifecycle. The
// implementation is split by concern — see barney.sessionRegistry.ts (in-memory
// session store + TTL eviction), barney.session.service.ts (createSession for
// all four modes), barney.message.service.ts (sendMessage/streamMessage), and
// barney.language.service.ts (the mid-interview language toggle) — but routes
// and tests import everything from here so the split is invisible to callers.
export { createSession, MatchNotFoundError, MatchOwnershipError } from "./barney.session.service";
export { sendMessage, streamMessage } from "./barney.message.service";
export { changeLanguage } from "./barney.language.service";
export { SessionNotFoundError, __resetSessions } from "./barney.sessionRegistry";
