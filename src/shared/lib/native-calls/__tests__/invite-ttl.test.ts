import { describe, expect, it } from "vitest";
import { isInviteEventExpired, DEFAULT_INVITE_LIFETIME_MS } from "../invite-ttl";

describe("isInviteEventExpired", () => {
  const now = 1_700_000_000_000;

  it("treats fresh invites as not expired", () => {
    expect(
      isInviteEventExpired({ originServerTs: now - 5_000, now }),
    ).toBe(false);
  });

  it("treats invites older than default lifetime as expired", () => {
    expect(
      isInviteEventExpired({
        originServerTs: now - DEFAULT_INVITE_LIFETIME_MS - 1,
        now,
      }),
    ).toBe(true);
  });

  it("uses content.lifetime when provided", () => {
    // 30s lifetime, 31s old → expired
    expect(
      isInviteEventExpired({
        originServerTs: now - 31_000,
        lifetime: 30_000,
        now,
      }),
    ).toBe(true);
    // 30s lifetime, 29s old → not expired
    expect(
      isInviteEventExpired({
        originServerTs: now - 29_000,
        lifetime: 30_000,
        now,
      }),
    ).toBe(false);
  });

  it("falls back to default lifetime for nullish content.lifetime", () => {
    expect(
      isInviteEventExpired({
        originServerTs: now - DEFAULT_INVITE_LIFETIME_MS - 1,
        lifetime: undefined,
        now,
      }),
    ).toBe(true);
  });

  it("treats non-positive timestamps as expired (defensive)", () => {
    expect(isInviteEventExpired({ originServerTs: 0, now })).toBe(true);
    expect(isInviteEventExpired({ originServerTs: -1, now })).toBe(true);
  });

  it("clamps absurdly large lifetime to a 5-minute ceiling", () => {
    // A homeserver bug echoing a 1-hour lifetime should not let a stale
    // invite leak through — this is exactly the S4 false-positive
    // ringtone-after-hangup scenario.
    expect(
      isInviteEventExpired({
        originServerTs: now - 6 * 60_000,
        lifetime: 60 * 60_000,
        now,
      }),
    ).toBe(true);
  });

  it("treats invite at exact lifetime boundary as expired", () => {
    expect(
      isInviteEventExpired({
        originServerTs: now - 60_000,
        lifetime: 60_000,
        now,
      }),
    ).toBe(true);
  });
});
