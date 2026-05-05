import { describe, it, expect } from "vitest";
import { isPeerKeysOk, type PeerKeysOkInput } from "./peer-keys-ok";

const base: PeerKeysOkInput = {
  status: "available",
  isGroupOrPublic: false,
  inGracePeriod: false,
};

describe("isPeerKeysOk", () => {
  it("private 1:1 with available keys allows send", () => {
    expect(isPeerKeysOk(base)).toBe(true);
  });

  // Regression #597/#598/#639: send button stayed disabled forever after the
  // 1.10.16 update because peer keys did not propagate. Group/public rooms
  // never had to block — they fall back to plaintext anyway.
  it("group room never blocks send (allows plaintext fallback)", () => {
    expect(
      isPeerKeysOk({ ...base, status: "missing", isGroupOrPublic: true }),
    ).toBe(true);
  });

  // Grace period: when the user just opened a chat, peer-keys may still be
  // loading. Block button only after the grace period to avoid the
  // "permanently disabled" UX.
  it("grace period unblocks send while peer keys are still loading", () => {
    expect(
      isPeerKeysOk({ ...base, status: "missing", inGracePeriod: true }),
    ).toBe(true);
  });

  it("private 1:1 with missing keys after grace blocks send", () => {
    expect(isPeerKeysOk({ ...base, status: "missing" })).toBe(false);
  });

  it("private 1:1 with not-encrypted (large room) allows send", () => {
    expect(isPeerKeysOk({ ...base, status: "not-encrypted" })).toBe(true);
  });

  it("private 1:1 with unknown status (crypto not initialised) allows send", () => {
    expect(isPeerKeysOk({ ...base, status: "unknown" })).toBe(true);
  });

  it("undefined status (peerKeysStatus not yet set) allows send", () => {
    expect(isPeerKeysOk({ ...base, status: undefined })).toBe(true);
  });

  it("group room with missing keys + grace + sending — still ok", () => {
    expect(
      isPeerKeysOk({
        status: "missing",
        isGroupOrPublic: true,
        inGracePeriod: true,
      }),
    ).toBe(true);
  });
});
