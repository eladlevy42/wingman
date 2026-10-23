// ChooseTimes polls GET /api/users/:id/state every few seconds. A poll already
// in flight when the proposer's POST /api/match/availability resolves can land
// afterwards carrying the pre-submit `false`, knocking the proposer's "Times
// sent." pending view back to an empty slot picker until the next poll
// restores it (#547). The server's hasSubmittedAvailability never flips back
// to false once a match is in CHOOSING_TIMES, so the client can safely OR the
// incoming value into the previous one instead of overwriting it.
export function stickyHasSubmitted(prev: boolean, incoming: boolean | null | undefined): boolean {
  return prev || (incoming ?? false);
}
