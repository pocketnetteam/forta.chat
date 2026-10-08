import { describe, it, expect } from "vitest";
import {
  parseBasytonLink,
  toBasytonUrl,
  toBasytonHttpsUrl,
  BASTYON_LINK_RE,
  BASTYON_COLLECTION_LINK_RE,
  parseBastyonCollectionLink,
  toBastyonCollectionUrl,
  toBastyonCollectionHttpsUrl,
  isBastyonBlockUrl,
  BASTYON_SCHEME_LINK_RE,
  bastyonSchemeToHttps,
  bastyonLinksToHttps,
  parseBastyonProfileLink,
  parseBastyonRoomLink,
  parseBastyonTransactionLink,
  toBastyonPostHttpsUrl,
  toTransactionExplorerUrl,
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

  it("extracts commentId from Bastyon's &commentid= param", () => {
    const r = parseBasytonLink(`bastyon://post?s=${TXID}&commentid=${COMMENT_ID}&parentid=${"c".repeat(64)}`);
    expect(r?.commentId).toBe(COMMENT_ID);
  });

  // ─── Posts under the author's channel path (Bastyon share format) ──
  it("parses a comment link under the author's username", () => {
    const url = `https://bastyon.com/daniel_satchkov?s=${TXID}&address=phdw4pwwbfdoofvhsefpshgradmrvzdbe5&commentid=${COMMENT_ID}`;
    expect(parseBasytonLink(url)).toEqual({ txid: TXID, commentId: COMMENT_ID, isVideo: false });
  });

  it("parses username-path posts on the deep link, pocketnet:// and www.", () => {
    expect(parseBasytonLink(`bastyon://kleine_viogelein?s=${TXID}`)?.txid).toBe(TXID);
    expect(parseBasytonLink(`pocketnet://post?s=${TXID}`)?.txid).toBe(TXID);
    expect(parseBasytonLink(`https://www.bastyon.com/name?v=${TXID}`)?.isVideo).toBe(true);
  });

  it("rejects nested paths and other hosts with a username path", () => {
    expect(parseBasytonLink(`https://bastyon.com/images/x?s=${TXID}`)).toBeNull();
    expect(parseBasytonLink(`https://matrix.bastyon.com/name?s=${TXID}`)).toBeNull();
    expect(parseBasytonLink(`https://bastyon.com/collection?s=${TXID}`)).toBeNull();
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

  it("rejects Bastyon pages that are not post paths", () => {
    expect(parseBasytonLink(`https://bastyon.com/author?s=${TXID}`)).toBeNull();
    expect(parseBasytonLink(`https://bastyon.com/embedVideo.php?s=${TXID}`)).toBeNull();
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
    ).toBe(`bastyon://post?s=${TXID}&commentid=${COMMENT_ID}`);
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
    ).toBe(`https://bastyon.com/post?s=${TXID}&commentid=${COMMENT_ID}`);
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

  it("matches a whole comment link under the author's username", () => {
    const url = `https://bastyon.com/daniel_satchkov?s=${TXID}&address=phdw4pwwbfdoofvhsefpshgradmrvzdbe5&commentid=${COMMENT_ID}`;
    expect(matchAll(`see ${url} here`)).toEqual([url]);
  });
});

// ─── Collections ─────────────────────────────────────────────────

describe("parseBastyonCollectionLink", () => {
  it("parses https://bastyon.com/collection?c=txid", () => {
    expect(parseBastyonCollectionLink(`https://bastyon.com/collection?c=${TXID}`)).toEqual({ txid: TXID });
  });

  it("parses bastyon://collection?c=txid", () => {
    expect(parseBastyonCollectionLink(`bastyon://collection?c=${TXID}`)).toEqual({ txid: TXID });
  });

  it("parses pocketnet.app / forta.chat hosts, trailing slash and extra params", () => {
    expect(parseBastyonCollectionLink(`https://pocketnet.app/collection/?ref=x&c=${TXID}`)).toEqual({ txid: TXID });
    expect(parseBastyonCollectionLink(`https://forta.chat/collection?c=${TXID}&ref=x`)).toEqual({ txid: TXID });
  });

  it("lowercases the txid", () => {
    expect(parseBastyonCollectionLink(`https://bastyon.com/collection?c=${"A".repeat(64)}`)).toEqual({ txid: TXID });
  });

  it("rejects other paths, hosts and malformed txids", () => {
    expect(parseBastyonCollectionLink(`https://bastyon.com/collections?c=${TXID}`)).toBeNull();
    expect(parseBastyonCollectionLink(`https://bastyon.com/post?c=${TXID}`)).toBeNull();
    expect(parseBastyonCollectionLink(`https://evil.com/collection?c=${TXID}`)).toBeNull();
    expect(parseBastyonCollectionLink(`https://bastyon.com/collection?c=${"a".repeat(63)}`)).toBeNull();
    expect(parseBastyonCollectionLink(`https://bastyon.com/collection?s=${TXID}`)).toBeNull();
  });

  it("builds canonical urls", () => {
    expect(toBastyonCollectionUrl(TXID)).toBe(`bastyon://collection?c=${TXID}`);
    expect(toBastyonCollectionHttpsUrl(TXID)).toBe(`https://bastyon.com/collection?c=${TXID}`);
  });
});

describe("BASTYON_COLLECTION_LINK_RE", () => {
  function matchAll(text: string): string[] {
    BASTYON_COLLECTION_LINK_RE.lastIndex = 0;
    return [...text.matchAll(BASTYON_COLLECTION_LINK_RE)].map((m) => m[0]);
  }

  it("finds a collection link inside text", () => {
    expect(matchAll(`Look https://bastyon.com/collection?c=${TXID} here`)).toEqual([
      `https://bastyon.com/collection?c=${TXID}`,
    ]);
  });

  it("does not match post links and post links do not match collections", () => {
    expect(matchAll(`bastyon://post?s=${TXID}&c=${COMMENT_ID}`)).toHaveLength(0);
    BASTYON_LINK_RE.lastIndex = 0;
    expect([...`bastyon://collection?c=${TXID}`.matchAll(BASTYON_LINK_RE)]).toHaveLength(0);
  });

  it("does not match unknown host", () => {
    expect(matchAll(`https://evil.com/collection?c=${TXID}`)).toHaveLength(0);
  });
});

describe("isBastyonBlockUrl", () => {
  it("is true for post and collection links rendered as cards", () => {
    expect(isBastyonBlockUrl(`https://bastyon.com/post?s=${TXID}`)).toBe(true);
    expect(isBastyonBlockUrl(`https://bastyon.com/collection?c=${TXID}`)).toBe(true);
  });

  it("is false for other urls and empty input", () => {
    expect(isBastyonBlockUrl("https://bastyon.com/author?address=PX")).toBe(false);
    expect(isBastyonBlockUrl("https://example.com/collection?c=" + TXID)).toBe(false);
    expect(isBastyonBlockUrl("")).toBe(false);
  });
});

// ─── Custom scheme ───────────────────────────────────────────────

const ADDRESS = "PR7srzZt4EfcNb3s27grgmiG8aB9vYNV82";
const REF = "pagmrr7irwgghwe3xusfvumdaedwtwrdn2";

describe("bastyonSchemeToHttps", () => {
  it("maps bastyon:// and pocketnet:// to https://bastyon.com/", () => {
    expect(bastyonSchemeToHttps(`bastyon://kleine_viogelein?ref=${REF}`))
      .toBe(`https://bastyon.com/kleine_viogelein?ref=${REF}`);
    expect(bastyonSchemeToHttps(`pocketnet://post?s=${TXID}`)).toBe(`https://bastyon.com/post?s=${TXID}`);
    expect(bastyonSchemeToHttps("BASTYON://name")).toBe("https://bastyon.com/name");
  });

  it("leaves other URLs untouched", () => {
    expect(bastyonSchemeToHttps("https://example.com/a")).toBe("https://example.com/a");
  });
});

describe("bastyonLinksToHttps", () => {
  it("rewrites every deep link in a text, keeping trailing punctuation", () => {
    expect(bastyonLinksToHttps(`Look: bastyon://kleine_viogelein?ref=${REF}, and bastyon://post?s=${TXID}.`))
      .toBe(`Look: https://bastyon.com/kleine_viogelein?ref=${REF}, and https://bastyon.com/post?s=${TXID}.`);
  });

  it("keeps text without deep links as is", () => {
    expect(bastyonLinksToHttps("plain https://bastyon.com/x")).toBe("plain https://bastyon.com/x");
    expect(bastyonLinksToHttps("")).toBe("");
  });

  it("leaves a deep link that is a parameter of another URL alone", () => {
    expect(bastyonLinksToHttps("https://x.com/r?to=bastyon://john")).toBe("https://x.com/r?to=bastyon://john");
    expect(bastyonLinksToHttps("(bastyon://john)")).toBe("(https://bastyon.com/john)");
  });

  it("does not match a bare scheme", () => {
    expect([..."bastyon:// alone".matchAll(BASTYON_SCHEME_LINK_RE)]).toHaveLength(0);
  });
});

describe("parseBastyonProfileLink", () => {
  it("parses a username deep link with ref", () => {
    expect(parseBastyonProfileLink(`bastyon://kleine_viogelein?ref=${REF}`)).toEqual({ name: "kleine_viogelein" });
  });

  it("parses a username on bastyon.com and pocketnet.app", () => {
    expect(parseBastyonProfileLink("https://bastyon.com/kleine_viogelein")).toEqual({ name: "kleine_viogelein" });
    expect(parseBastyonProfileLink("https://www.bastyon.com/Name_1/")).toEqual({ name: "Name_1" });
    expect(parseBastyonProfileLink("https://pocketnet.app/name")).toEqual({ name: "name" });
  });

  it("parses a percent-encoded unicode username", () => {
    expect(parseBastyonProfileLink(`bastyon://${encodeURIComponent("Пётр")}`)).toEqual({ name: "Пётр" });
  });

  it("parses author/user links by address", () => {
    expect(parseBastyonProfileLink(`bastyon://author?address=${ADDRESS}`)).toEqual({ address: ADDRESS });
    expect(parseBastyonProfileLink(`https://bastyon.com/user?address=${ADDRESS}`)).toEqual({ address: ADDRESS });
    expect(parseBastyonProfileLink("https://bastyon.com/author?address=PX")).toBeNull();
  });

  it("rejects posts, collections and Bastyon pages", () => {
    expect(parseBastyonProfileLink(`bastyon://post?s=${TXID}`)).toBeNull();
    expect(parseBastyonProfileLink(`bastyon://index?v=${TXID}`)).toBeNull();
    expect(parseBastyonProfileLink(`bastyon://collection?c=${TXID}`)).toBeNull();
    expect(parseBastyonProfileLink("https://bastyon.com/faq")).toBeNull();
    expect(parseBastyonProfileLink("https://bastyon.com/")).toBeNull();
    expect(parseBastyonProfileLink("https://bastyon.com/images/abc")).toBeNull();
    expect(parseBastyonProfileLink("https://bastyon.com/embedVideo.php?id=1")).toBeNull();
  });

  it("rejects foreign hosts, forta.chat routes and Bastyon subdomains", () => {
    expect(parseBastyonProfileLink("https://example.com/name")).toBeNull();
    expect(parseBastyonProfileLink("https://forta.chat/settings")).toBeNull();
    expect(parseBastyonProfileLink("https://matrix.bastyon.com/name")).toBeNull();
    expect(parseBastyonProfileLink("https://evil.com/bastyon.com/name")).toBeNull();
  });

  it("parses connect= invites as a profile by address, whatever the path", () => {
    expect(parseBastyonProfileLink(`bastyon://welcome?connect=${ADDRESS}`)).toEqual({ address: ADDRESS });
    expect(parseBastyonProfileLink(`https://bastyon.com/welcome?connect=${ADDRESS}`)).toEqual({ address: ADDRESS });
    expect(parseBastyonProfileLink("https://bastyon.com/welcome?connect=bad!")).toBeNull();
  });

  it("leaves room and transaction links to their own parsers", () => {
    expect(parseBastyonProfileLink("bastyon://welcome?publicroom=!abc:matrix.pocketnet.app")).toBeNull();
    expect(parseBastyonProfileLink(`bastyon://i?stx=${TXID}`)).toBeNull();
  });

  it("makes profile links block URLs (no duplicate OG preview)", () => {
    expect(isBastyonBlockUrl("https://bastyon.com/kleine_viogelein")).toBe(true);
  });
});

describe("parseBastyonRoomLink", () => {
  const ROOM = "!AbC123:matrix.pocketnet.app";

  it("parses publicroom= on the deep link and on bastyon.com", () => {
    expect(parseBastyonRoomLink(`bastyon://welcome?publicroom=${ROOM}`)).toEqual({ roomId: ROOM });
    expect(parseBastyonRoomLink(`https://bastyon.com/welcome?publicroom=${encodeURIComponent(ROOM)}`))
      .toEqual({ roomId: ROOM });
  });

  it("rejects malformed room ids and foreign hosts", () => {
    expect(parseBastyonRoomLink("bastyon://welcome?publicroom=!../../evil:server/x")).toBeNull();
    expect(parseBastyonRoomLink("bastyon://welcome?publicroom=abc")).toBeNull();
    expect(parseBastyonRoomLink(`https://example.com/welcome?publicroom=${ROOM}`)).toBeNull();
    expect(parseBastyonRoomLink("bastyon://kleine_viogelein")).toBeNull();
  });

  it("makes room links block URLs", () => {
    expect(isBastyonBlockUrl(`https://bastyon.com/welcome?publicroom=${ROOM}`)).toBe(true);
  });
});

describe("parseBastyonTransactionLink", () => {
  it("parses stx= (case-insensitive txid)", () => {
    expect(parseBastyonTransactionLink(`bastyon://i?stx=${TXID}`)).toEqual({ txid: TXID });
    expect(parseBastyonTransactionLink(`https://bastyon.com/index?stx=${TXID.toUpperCase()}`)).toEqual({ txid: TXID });
  });

  it("rejects non-hex64 ids and foreign hosts", () => {
    expect(parseBastyonTransactionLink("bastyon://i?stx=abc")).toBeNull();
    expect(parseBastyonTransactionLink(`https://example.com/i?stx=${TXID}`)).toBeNull();
  });

  it("makes transaction links block URLs and builds the explorer URL", () => {
    expect(isBastyonBlockUrl(`bastyon://i?stx=${TXID}`)).toBe(true);
    expect(toTransactionExplorerUrl(TXID)).toBe(`https://bastyon.com/blockexplorer/transaction/${TXID}`);
  });
});

describe("toBastyonPostHttpsUrl", () => {
  it("builds the https post link Forta shares and copies", () => {
    expect(toBastyonPostHttpsUrl(TXID)).toBe(`https://bastyon.com/post?s=${TXID}`);
    expect(parseBasytonLink(toBastyonPostHttpsUrl(TXID))).toEqual({ txid: TXID, commentId: undefined, isVideo: false });
  });
});
