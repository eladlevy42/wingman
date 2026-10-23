import { describe, it, expect } from "vitest";
import { isAtBottom, shouldFollowNewContent, AT_BOTTOM_THRESHOLD_PX } from "./scrollPinning";

// A 1000px conversation seen through a 400px window: the bottom is offset 600.
const tall = (offset: number) => ({ offset, viewportLength: 400, contentLength: 1000 });

describe("isAtBottom", () => {
  it("is true when scrolled exactly to the end", () => {
    expect(isAtBottom(tall(600))).toBe(true);
  });

  it("is true just inside the threshold, so a bubble growing a line still follows", () => {
    expect(isAtBottom(tall(600 - AT_BOTTOM_THRESHOLD_PX))).toBe(true);
  });

  it("is false just outside the threshold — the reader scrolled up deliberately", () => {
    expect(isAtBottom(tall(600 - AT_BOTTOM_THRESHOLD_PX - 1))).toBe(false);
  });

  it("is false when the reader has scrolled well up to re-read an earlier question", () => {
    expect(isAtBottom(tall(0))).toBe(false);
  });

  it("treats overscroll past the end as at the bottom", () => {
    expect(isAtBottom(tall(640))).toBe(true);
  });

  it("is true when the content is shorter than the viewport", () => {
    // A conversation that has only just started has nothing to scroll, and must
    // still follow its first replies.
    expect(isAtBottom({ offset: 0, viewportLength: 400, contentLength: 120 })).toBe(true);
  });

  it("honours a custom threshold", () => {
    expect(isAtBottom(tall(500), 100)).toBe(true);
    expect(isAtBottom(tall(500), 99)).toBe(false);
  });
});

describe("shouldFollowNewContent", () => {
  it("follows when the reader was at the bottom before a new bubble arrived", () => {
    // Was 1000 tall with the reader at the end (offset 600); an 80px bubble
    // lands, so they now measure 80px adrift purely because of the growth.
    expect(
      shouldFollowNewContent({ offset: 600, viewportLength: 400, contentLength: 1080 }, 1000)
    ).toBe(true);
  });

  it("follows through a large arrival, not just a one-line typewriter tick", () => {
    expect(
      shouldFollowNewContent({ offset: 600, viewportLength: 400, contentLength: 1600 }, 1000)
    ).toBe(true);
  });

  it("does not follow when the reader had scrolled up before the growth", () => {
    // Parked at the top of a 1000px conversation, then 80px arrives.
    expect(
      shouldFollowNewContent({ offset: 0, viewportLength: 400, contentLength: 1080 }, 1000)
    ).toBe(false);
  });

  it("does not follow a reader who scrolled up just past the threshold", () => {
    const offset = 600 - AT_BOTTOM_THRESHOLD_PX - 1;
    expect(shouldFollowNewContent({ offset, viewportLength: 400, contentLength: 1080 }, 1000)).toBe(
      false
    );
  });

  it("follows on the first run, when nothing has been recorded yet", () => {
    expect(shouldFollowNewContent({ offset: 0, viewportLength: 400, contentLength: 1000 }, 0)).toBe(
      true
    );
  });

  it("treats shrinking content as no growth rather than a negative nudge", () => {
    // A cleared conversation: shorter than before, reader at the bottom.
    expect(
      shouldFollowNewContent({ offset: 0, viewportLength: 400, contentLength: 200 }, 1000)
    ).toBe(true);
  });

  it("does not follow a reader scrolled up in content that shrank", () => {
    expect(
      shouldFollowNewContent({ offset: 0, viewportLength: 400, contentLength: 900 }, 1000)
    ).toBe(false);
  });
});
