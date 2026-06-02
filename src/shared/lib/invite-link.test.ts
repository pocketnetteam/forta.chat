import { describe, it, expect } from "vitest";

import { buildInviteUrl, buildJoinUrl } from "./invite-link";
import { parseInviteUrl, parseJoinUrl } from "./parse-invite-url";

const ADDR = "PABCdefGHIjklMNOpqrSTUvwx12";
const ROOM_ID = "!abc123:matrix.bastyon.com";

describe("buildInviteUrl", () => {
  it("emits the hash-routing path so the static host never 404s", () => {
    const url = buildInviteUrl(ADDR);
    expect(url).toContain("#/invite");
    // The bug we are fixing: a bare `forta.chat/invite` path has no file on
    // the static host and returns 404. Assert we never regress to it.
    expect(url).not.toMatch(/forta\.chat\/invite/);
  });

  it("carries the referral address", () => {
    expect(buildInviteUrl(ADDR)).toContain(`ref=${ADDR}`);
  });

  it("round-trips through parseInviteUrl", () => {
    expect(parseInviteUrl(buildInviteUrl(ADDR))).toEqual({ address: ADDR });
  });
});

describe("buildJoinUrl", () => {
  it("emits the hash-routing path so the static host never 404s", () => {
    const url = buildJoinUrl(ROOM_ID);
    expect(url).toContain("#/join");
    // Confirmed root cause of WEE-27 (forta-bugs#435/#29): the bare
    // `forta.chat/join?room=...` link 404s under hash routing.
    expect(url).not.toMatch(/forta\.chat\/join/);
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
