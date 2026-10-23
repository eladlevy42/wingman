import { describe, expect, it } from "vitest";
import { formatHeight } from "./formatHeight";

describe("formatHeight", () => {
  it("renders centimetres with the imperial equivalent", () => {
    expect(formatHeight(175)).toBe(`175 cm (5'9")`);
  });

  it("rolls 12 inches over into the next foot", () => {
    // 183cm rounds to 72 inches, which must read 6'0" and never 5'12".
    expect(formatHeight(183)).toBe(`183 cm (6'0")`);
  });

  it("matches the web client at the ends of the usual range", () => {
    expect(formatHeight(140)).toBe(`140 cm (4'7")`);
    expect(formatHeight(210)).toBe(`210 cm (6'11")`);
  });
});
