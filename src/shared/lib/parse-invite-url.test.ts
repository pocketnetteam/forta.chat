import { describe, it, expect } from "vitest";
import { parseInviteUrl, parseJoinUrl, parseDeepLink } from "./parse-invite-url";

const VALID_ADDR = "PMyAddress1234567890ABCDEFGHIJKLMN";
const ROOM_ID = "!abcdef123:matrix.pocketnet.app";

describe("parseInviteUrl", () => {
  it("parses https path-based invite URL (App Links)", () => {
    expect(parseInviteUrl(`https://forta.chat/invite?ref=${VALID_ADDR}`)).toEqual({
      address: VALID_ADDR,
    });
  });

  it("parses https hash-based invite URL (Vue hash router)", () => {
    expect(parseInviteUrl(`https://forta.chat/#/invite?ref=${VALID_ADDR}`)).toEqual({
      address: VALID_ADDR,
    });
  });

  it("parses https hash-based invite URL with no leading slash", () => {
    expect(parseInviteUrl(`https://forta.chat#/invite?ref=${VALID_ADDR}`)).toEqual({
      address: VALID_ADDR,
    });
  });

  it("parses www.forta.chat variant", () => {
    expect(parseInviteUrl(`https://www.forta.chat/invite?ref=${VALID_ADDR}`)).toEqual({
      address: VALID_ADDR,
    });
  });

  it("parses custom scheme forta://invite?ref=", () => {
    expect(parseInviteUrl(`forta://invite?ref=${VALID_ADDR}`)).toEqual({
      address: VALID_ADDR,
    });
  });

  it("tolerates trailing slash on invite path", () => {
    expect(parseInviteUrl(`https://forta.chat/invite/?ref=${VALID_ADDR}`)).toEqual({
      address: VALID_ADDR,
    });
  });

  it("returns null for missing ref param", () => {
    expect(parseInviteUrl("https://forta.chat/invite")).toBeNull();
  });

  it("returns null for empty ref param", () => {
    expect(parseInviteUrl("https://forta.chat/invite?ref=")).toBeNull();
  });

  it("returns null for non-invite path", () => {
    expect(parseInviteUrl(`https://forta.chat/somewhere?ref=${VALID_ADDR}`)).toBeNull();
  });

  it("returns null for unknown host", () => {
    expect(parseInviteUrl(`https://evil.com/invite?ref=${VALID_ADDR}`)).toBeNull();
  });

  it("returns null for malformed URL", () => {
    expect(parseInviteUrl("not a url")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseInviteUrl("")).toBeNull();
  });

  it("rejects ref that is not bastyon address shape (too short)", () => {
    expect(parseInviteUrl("https://forta.chat/invite?ref=abc")).toBeNull();
  });

  it("rejects ref with unsafe characters", () => {
    expect(parseInviteUrl("https://forta.chat/invite?ref=<script>")).toBeNull();
  });

  it("rejects ref with percent-encoded control bytes", () => {
    // `%0A` decodes to `\n`, which fails the alphanumeric regex — even though
    // the raw URL parses. Guards against a homeserver injecting newline-laden
    // directory results into Vue template interpolation.
    expect(parseInviteUrl("https://forta.chat/invite?ref=P%0AAddress1234567890ABCDEFGHIJKL")).toBeNull();
  });
});

describe("parseJoinUrl", () => {
  it("parses https path-based join URL", () => {
    const encoded = encodeURIComponent(ROOM_ID);
    expect(parseJoinUrl(`https://forta.chat/join?room=${encoded}`)).toEqual({
      roomId: ROOM_ID,
    });
  });

  it("parses hash-based join URL", () => {
    const encoded = encodeURIComponent(ROOM_ID);
    expect(parseJoinUrl(`https://forta.chat/#/join?room=${encoded}`)).toEqual({
      roomId: ROOM_ID,
    });
  });

  it("parses custom scheme forta://join?room=", () => {
    const encoded = encodeURIComponent(ROOM_ID);
    expect(parseJoinUrl(`forta://join?room=${encoded}`)).toEqual({
      roomId: ROOM_ID,
    });
  });

  it("returns null for missing room param", () => {
    expect(parseJoinUrl("https://forta.chat/join")).toBeNull();
  });

  it("returns null for invalid roomId shape", () => {
    expect(parseJoinUrl("https://forta.chat/join?room=notaroom")).toBeNull();
  });

  it("returns null for non-forta host", () => {
    expect(parseJoinUrl(`https://evil.com/join?room=${encodeURIComponent(ROOM_ID)}`)).toBeNull();
  });
});

describe("parseDeepLink", () => {
  it("dispatches invite URL to invite target", () => {
    expect(parseDeepLink(`https://forta.chat/invite?ref=${VALID_ADDR}`)).toEqual({
      kind: "invite",
      address: VALID_ADDR,
    });
  });

  it("dispatches join URL to join target", () => {
    const encoded = encodeURIComponent(ROOM_ID);
    expect(parseDeepLink(`https://forta.chat/join?room=${encoded}`)).toEqual({
      kind: "join",
      roomId: ROOM_ID,
    });
  });

  it("returns null for unrelated Bastyon post link", () => {
    expect(parseDeepLink(`https://forta.chat/post?s=${"a".repeat(64)}`)).toBeNull();
  });

  it("returns null for completely foreign URL", () => {
    expect(parseDeepLink("https://example.com/anything")).toBeNull();
  });
});
