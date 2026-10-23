import { describe, expect, it } from "vitest";
import { TRACKS, trackInfo } from "./tracks";

describe("trackInfo", () => {
  it("returns the matching track for each id", () => {
    for (const track of TRACKS) {
      expect(trackInfo(track.id)).toBe(track);
    }
  });

  it("defaults to Track 1 for an unrecognized id", () => {
    expect(trackInfo(99 as never)).toBe(TRACKS[0]);
  });
});
