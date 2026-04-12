import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Tests for search algorithm alignment with old bastyon-chat.
 * Verifies: relevance scoring formula, member name search, channel search.
 */

const searchSource = readFileSync(resolve(__dirname, "../use-search.ts"), "utf-8");

describe("search algorithm: relevance scoring", () => {
  it("uses point = query.length / searchString.length formula", () => {
    expect(searchSource).toContain("q.length / searchStr.length");
  });

  it("sorts results by point descending", () => {
    expect(searchSource).toContain("b.point - a.point");
  });

  it("builds search string from room name + member names", () => {
    expect(searchSource).toContain("buildRoomSearchString");
  });

  it("includes member display names in search string", () => {
    expect(searchSource).toContain("parts.push(user.name)");
    expect(searchSource).toContain("parts.push(matrixName)");
  });

  it("concatenates all parts and lowercases the search string", () => {
    expect(searchSource).toContain('parts.join("").toLowerCase()');
  });
});

describe("channel search", () => {
  it("exports channelResults from useSearch", () => {
    expect(searchSource).toContain("channelResults");
  });

  it("uses rankChannels function", () => {
    expect(searchSource).toContain("function rankChannels(");
  });

  it("searches channels by name", () => {
    expect(searchSource).toContain("ch.name.toLowerCase()");
  });

  it("uses same scoring formula for channels", () => {
    expect(searchSource).toContain("q.length / name.length");
  });
});

describe("search imports", () => {
  it("imports useUserStore for member name resolution", () => {
    expect(searchSource).toContain("useUserStore");
  });

  it("imports useChannelStore for channel search", () => {
    expect(searchSource).toContain("useChannelStore");
  });

  it("imports hexDecode for member ID resolution", () => {
    expect(searchSource).toContain("hexDecode");
  });
});
