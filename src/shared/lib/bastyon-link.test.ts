import { describe, it, expect } from "vitest";
import {
  parseBasytonLink,
  toBasytonUrl,
  toBasytonHttpsUrl,
  BASTYON_LINK_RE,
} from "./bastyon-link";

const TXID = "a".repeat(64);
const COMMENT_ID = "b".repeat(64);

// ─── parseBasytonLink ────────────────────────────────────────────

describe("parseBasytonLink", () => {
  // ─── Basic formats ─────────────────────────────────────────
  it("parses bastyon://post?s=txid", () => {
    expect(parseBasytonLink(`bastyon://post?s=${TXID}`)).toEqual({
      txid: TXID,
      commentId: undefined,
      isVideo: false,
    });
  });

  it("parses bastyon://index?v=txid as video", () => {
    expect(parseBasytonLink(`bastyon://index?v=${TXID}`)).toEqual({
      txid: TXID,
      commentId: undefined,
      isVideo: true,
    });
  });

  it("parses https://bastyon.com/post?s=txid", () => {
    const r = parseBasytonLink(`https://bastyon.com/post?s=${TXID}`);
    expect(r?.txid).toBe(TXID);
    expect(r?.isVideo).toBe(false);
  });

  it("parses https://pocketnet.app/post?s=txid", () => {
    const r = parseBasytonLink(`https://pocketnet.app/post?s=${TXID}`);
    expect(r?.txid).toBe(TXID);
  });

  it("parses https://forta.chat/post?s=txid", () => {
    const r = parseBasytonLink(`https://forta.chat/post?s=${TXID}`);
    expect(r?.txid).toBe(TXID);
  });

  it("parses http:// variant", () => {
    const r = parseBasytonLink(`http://bastyon.com/post?s=${TXID}`);
    expect(r?.txid).toBe(TXID);
  });

  // ─── Comment deep links ────────────────────────────────────
  it("extracts commentId from &c= param", () => {
    const r = parseBasytonLink(`bastyon://post?s=${TXID}&c=${COMMENT_ID}`);
    expect(r?.commentId).toBe(COMMENT_ID);
  });

  it("extracts commentId from #comment- fragment", () => {
    const r = parseBasytonLink(
      `https://bastyon.com/post?s=${TXID}#comment-${COMMENT_ID}`,
    );
    expect(r?.commentId).toBe(COMMENT_ID);
  });

  it("&c= takes priority over fragment", () => {
    const otherComment = "c".repeat(64);
    const r = parseBasytonLink(
      `bastyon://post?s=${TXID}&c=${COMMENT_ID}#comment-${otherComment}`,
    );
    expect(r?.commentId).toBe(COMMENT_ID);
  });

  it("ignores invalid commentId (not hex64)", () => {
    const r = parseBasytonLink(`bastyon://post?s=${TXID}&c=invalid`);
    expect(r?.txid).toBe(TXID);
    expect(r?.commentId).toBeUndefined();
  });

  it("ignores short commentId fragment", () => {
    const r = parseBasytonLink(
      `bastyon://post?s=${TXID}#comment-${"a".repeat(32)}`,
    );
    expect(r?.commentId).toBeUndefined();
  });

  // ─── Video detection ───────────────────────────────────────
  it("detects video from &video=1", () => {
    const r = parseBasytonLink(`bastyon://post?s=${TXID}&video=1`);
    expect(r?.isVideo).toBe(true);
  });

  it("detects video from index path", () => {
    const r = parseBasytonLink(`https://bastyon.com/index?v=${TXID}`);
    expect(r?.isVideo).toBe(true);
  });

  it("post path without video flag is not video", () => {
    const r = parseBasytonLink(`bastyon://post?s=${TXID}`);
    expect(r?.isVideo).toBe(false);
  });

  // ─── Normalization ─────────────────────────────────────────
  it("normalizes uppercase hex to lowercase", () => {
    const upper = TXID.toUpperCase();
    const r = parseBasytonLink(`bastyon://post?s=${upper}`);
    expect(r?.txid).toBe(TXID);
  });

  it("handles txid not as first param", () => {
    const r = parseBasytonLink(
      `https://bastyon.com/post?ref=share&s=${TXID}`,
    );
    expect(r?.txid).toBe(TXID);
  });

  it("ignores unknown params gracefully", () => {
    const r = parseBasytonLink(
      `bastyon://post?s=${TXID}&ref=user123&share=1`,
    );
    expect(r?.txid).toBe(TXID);
    expect(r?.isVideo).toBe(false);
  });

  // ─── Invalid inputs ────────────────────────────────────────
  it("rejects unknown host", () => {
    expect(parseBasytonLink(`https://evil.com/post?s=${TXID}`)).toBeNull();
  });

  it("rejects short txid (63 chars)", () => {
    expect(
      parseBasytonLink(`bastyon://post?s=${"a".repeat(63)}`),
    ).toBeNull();
  });

  it("rejects non-hex txid", () => {
    expect(
      parseBasytonLink(`bastyon://post?s=${"g".repeat(64)}`),
    ).toBeNull();
  });

  it("rejects unknown path", () => {
    expect(parseBasytonLink(`bastyon://user?s=${TXID}`)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseBasytonLink("")).toBeNull();
  });

  it("returns null for random URL", () => {
    expect(parseBasytonLink("https://google.com")).toBeNull();
  });

  it("rejects bastyon host with wrong path", () => {
    expect(
      parseBasytonLink(`https://bastyon.com/profile?s=${TXID}`),
    ).toBeNull();
  });
});

// ─── toBasytonUrl ────────────────────────────────────────────────

describe("toBasytonUrl", () => {
  it("generates post URL", () => {
    expect(toBasytonUrl({ txid: TXID, isVideo: false })).toBe(
      `bastyon://post?s=${TXID}`,
    );
  });

  it("generates video URL", () => {
    expect(toBasytonUrl({ txid: TXID, isVideo: true })).toBe(
      `bastyon://index?v=${TXID}`,
    );
  });

  it("includes commentId", () => {
    expect(
      toBasytonUrl({ txid: TXID, commentId: COMMENT_ID, isVideo: false }),
    ).toBe(`bastyon://post?s=${TXID}&c=${COMMENT_ID}`);
  });
});

// ─── toBasytonHttpsUrl ──────────────────────────────────────────

describe("toBasytonHttpsUrl", () => {
  it("generates HTTPS post URL", () => {
    expect(toBasytonHttpsUrl({ txid: TXID, isVideo: false })).toBe(
      `https://bastyon.com/post?s=${TXID}`,
    );
  });

  it("generates HTTPS video URL", () => {
    expect(toBasytonHttpsUrl({ txid: TXID, isVideo: true })).toBe(
      `https://bastyon.com/index?v=${TXID}`,
    );
  });

  it("includes commentId in HTTPS URL", () => {
    expect(
      toBasytonHttpsUrl({
        txid: TXID,
        commentId: COMMENT_ID,
        isVideo: false,
      }),
    ).toBe(`https://bastyon.com/post?s=${TXID}&c=${COMMENT_ID}`);
  });
});

// ─── BASTYON_LINK_RE (detection regex) ──────────────────────────

describe("BASTYON_LINK_RE", () => {
  function matchAll(text: string): string[] {
    BASTYON_LINK_RE.lastIndex = 0;
    return [...text.matchAll(BASTYON_LINK_RE)].map((m) => m[0]);
  }

  it("matches bastyon:// link in text", () => {
    const matches = matchAll(`Check bastyon://post?s=${TXID} out`);
    expect(matches).toHaveLength(1);
  });

  it("matches https://bastyon.com link", () => {
    const matches = matchAll(`https://bastyon.com/post?s=${TXID}`);
    expect(matches).toHaveLength(1);
  });

  it("matches link with comment param", () => {
    const matches = matchAll(
      `bastyon://post?s=${TXID}&c=${COMMENT_ID}`,
    );
    expect(matches).toHaveLength(1);
  });

  it("matches multiple links in text", () => {
    const txid2 = "f".repeat(64);
    const matches = matchAll(
      `Link1: bastyon://post?s=${TXID} Link2: bastyon://post?s=${txid2}`,
    );
    expect(matches).toHaveLength(2);
  });

  it("does not match unknown host", () => {
    const matches = matchAll(`https://evil.com/post?s=${TXID}`);
    expect(matches).toHaveLength(0);
  });

  it("does not match short txid", () => {
    const matches = matchAll(`bastyon://post?s=${"a".repeat(63)}`);
    expect(matches).toHaveLength(0);
  });

  it("matches forta.chat links", () => {
    const matches = matchAll(`https://forta.chat/post?s=${TXID}`);
    expect(matches).toHaveLength(1);
  });
});
