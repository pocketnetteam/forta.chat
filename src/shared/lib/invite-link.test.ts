import { describe, it, expect } from "vitest";

import { buildInviteUrl, buildJoinUrl } from "./invite-link";
import { parseInviteUrl, parseJoinUrl } from "./parse-invite-url";

const ADDR = "PABCdefGHIjklMNOpqrSTUvwx12";
const ROOM_ID = "!abc123:matrix.bastyon.com";

describe("buildInviteUrl", () => {
  it("puts the target in the URL path (not the hash) so Android App Links match", () => {
    // WEE-104 regression: a hash-form link `forta.chat/#/invite?ref=...` has
    // path "/" — the `/invite` lives in the fragment, which Android App Links
    // never see — so the OS hands it to the browser (forta-bugs#1014). The
    // intent-filter `pathPrefix="/invite"` can only match a real path.
    const url = new URL(buildInviteUrl(ADDR));
    expect(url.pathname).toBe("/invite");
    expect(url.hash).toBe("");
  });

  it("carries the referral address", () => {
    expect(buildInviteUrl(ADDR)).toContain(`ref=${ADDR}`);
  });

  it("round-trips through parseInviteUrl", () => {
    expect(parseInviteUrl(buildInviteUrl(ADDR))).toEqual({ address: ADDR });
  });
});

describe("buildJoinUrl", () => {
  it("puts the target in the URL path (not the hash) so Android App Links match", () => {
    // Same App-Link path requirement as invites: the room id travels in the
    // query with `/join` as the real path the intent-filter claims, never the
    // fragment (which the OS can't route to the installed app).
    const url = new URL(buildJoinUrl(ROOM_ID));
    expect(url.pathname).toBe("/join");
    expect(url.hash).toBe("");
  });

  it("URL-encodes the room id separator", () => {
    // encodeURIComponent keeps `!` literal but escapes the `:` to %3A — the
    // raw colon must never reach the query string (it would break the param
    // split on some parsers / share targets).
    const url = buildJoinUrl(ROOM_ID);
    expect(url).toContain("room=!abc123%3Amatrix.bastyon.com");
    expect(url).not.toContain(":matrix.bastyon.com");
  });

  it("round-trips through parseJoinUrl", () => {
    expect(parseJoinUrl(buildJoinUrl(ROOM_ID))).toEqual({ roomId: ROOM_ID });
  });

  it("round-trips a room id carrying an explicit server port", () => {
    // The parser grammar allows `!local:server:port`; encoding both colons to
    // %3A must survive the URLSearchParams decode on the way back.
    const withPort = "!abc:matrix.bastyon.com:8448";
    const url = buildJoinUrl(withPort);
    expect(url).toContain("matrix.bastyon.com%3A8448");
    expect(parseJoinUrl(url)).toEqual({ roomId: withPort });
  });
});
