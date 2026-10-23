// Whether a scrolling chat should follow new content, or leave the reader where
// they are (#530).
//
// Both clients used to scroll to the newest content unconditionally — mobile on
// every `onContentSizeChange` (which fires on every typewriter tick, not only on
// a new message), web in an effect keyed on the message list. That made it
// impossible to scroll back and re-read an earlier question while a reply was
// streaming: the next tick yanked the reader back down.
//
// The rule both clients now share: follow the newest content only while the
// reader is already at the bottom. Once they scroll up they are reading, and
// nothing may move them; a "jump to latest" control returns them deliberately.
//
// Framework-free on purpose (CLAUDE.md §3) — React Native reports these three
// numbers on its scroll events and the DOM exposes the same three on an element,
// so keeping the predicate here means the two clients cannot drift apart on the
// one judgement that matters.

export interface ScrollMetrics {
  // Distance from the top of the content to the top of the viewport.
  offset: number;
  // Height of the visible window onto the content.
  viewportLength: number;
  // Total height of the scrollable content.
  contentLength: number;
}

// How close to the bottom still counts as "at the bottom". A reader who is a
// few pixels off — from a bounce, a rounding error, or a bubble growing by a
// line as it types — is still following the conversation and expects it to keep
// up. Small enough that a deliberate scroll away from the bottom is never
// mistaken for following.
export const AT_BOTTOM_THRESHOLD_PX = 48;

/**
 * True when the viewport is at (or within `threshold` of) the end of the
 * content — i.e. the reader is following the conversation and new content
 * should stay in view.
 *
 * Content shorter than the viewport is always "at the bottom": there is nothing
 * to scroll, so a chat that has only just started still follows its first
 * replies.
 */
export function isAtBottom(
  metrics: ScrollMetrics,
  threshold: number = AT_BOTTOM_THRESHOLD_PX
): boolean {
  const distanceFromBottom = metrics.contentLength - metrics.viewportLength - metrics.offset;
  // Negative distances come from overscroll/bounce past the end, which is even
  // more "at the bottom" than zero.
  return distanceFromBottom <= threshold;
}

/**
 * Whether a chat that has just grown should scroll to the newest content.
 *
 * Answers the question at the only moment it can be answered correctly: after
 * the content has grown, but reasoning about where the reader was *before* it
 * grew. Both facts matter and neither is available on its own:
 *
 *   - Asking "is the reader at the bottom?" after the growth is wrong. Adding a
 *     bubble pushes the end away by its own height, so someone who was following
 *     perfectly now measures as 80px adrift and the chat stops following them.
 *   - Trusting a flag maintained by scroll events is also wrong. Scroll events
 *     are delivered asynchronously, so a reader who has just dragged the list up
 *     is still recorded as pinned for a frame or two — and a typewriter tick
 *     landing in that window yanks them back down. That is the bug in #530, and
 *     it reproduced roughly two runs in three.
 *
 * Subtracting the growth from the current distance recovers where the reader
 * stood a moment ago, which is the thing worth knowing, and reads live geometry
 * so it can never be stale.
 *
 * `previousContentLength` is the content length recorded the last time this ran
 * (0 on first call — a fresh chat follows). Shrinking content, e.g. a cleared
 * conversation, yields a growth of 0 rather than a negative nudge.
 */
export function shouldFollowNewContent(
  metrics: ScrollMetrics,
  previousContentLength: number,
  threshold: number = AT_BOTTOM_THRESHOLD_PX
): boolean {
  const growth = Math.max(0, metrics.contentLength - previousContentLength);
  const distanceNow = metrics.contentLength - metrics.viewportLength - metrics.offset;
  return distanceNow - growth <= threshold;
}
