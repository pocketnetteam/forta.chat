// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { catchUpFromBlock, readBlockMark, writeBlockMark } from "../last-block-mark";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

describe("last-block-mark", () => {
  beforeEach(() => localStorage.clear());

  it("stores the block per account with its arrival time", () => {
    writeBlockMark("A", 500, NOW);
    expect(readBlockMark("A")).toEqual({ height: 500, at: NOW });
    expect(readBlockMark("B")).toBeNull();
  });

  it("ignores non-positive heights and corrupt entries", () => {
    writeBlockMark("A", 0, NOW);
    expect(readBlockMark("A")).toBeNull();
    localStorage.setItem("blockchain_ws_block:A", "{oops");
    expect(readBlockMark("A")).toBeNull();
  });

  describe("catchUpFromBlock", () => {
    it("is null without a mark", () => {
      expect(catchUpFromBlock(null, NOW)).toBeNull();
    });

    it("is null when fewer than 2 blocks were missed", () => {
      expect(catchUpFromBlock({ height: 500, at: NOW - 119_999 }, NOW)).toBeNull();
    });

    it("resumes from the mark for a gap within 2000 blocks", () => {
      expect(catchUpFromBlock({ height: 500, at: NOW - 2 * MIN }, NOW)).toBe(500);
      expect(catchUpFromBlock({ height: 500, at: NOW - 2_000 * MIN }, NOW)).toBe(500);
    });

    it("starts 2000 blocks before the estimated tip for a longer gap", () => {
      // A day away: ~1440 blocks → still from the mark; three days → capped.
      expect(catchUpFromBlock({ height: 500, at: NOW - 1_440 * MIN }, NOW)).toBe(500);
      expect(catchUpFromBlock({ height: 500, at: NOW - 4_320 * MIN }, NOW)).toBe(500 + 4_320 - 2_000);
    });
  });
});
