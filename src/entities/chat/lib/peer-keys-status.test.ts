import { describe, expect, it } from "vitest";
import { decidePeerKeysStatus } from "./peer-keys-status";

/**
 * Audit S1-01 / S7-03 follow-up. canBeEncrypt() now stays false until every
 * member's profile has loaded, and groups now show the peer-keys banner, so
 * "not loaded yet" must not be reported as "missing" — otherwise opening any
 * group flashed "a member hasn't published keys" while profiles were loading.
 * pcrypto.onKeysLoaded re-runs the check once they land.
 */
describe("decidePeerKeysStatus", () => {
  it("is available when the room can be encrypted", () => {
    expect(decidePeerKeysStatus({ canEncrypt: true, membersLoaded: true, memberCount: 3 })).toBe("available");
  });

  it("is unknown while member profiles are still loading", () => {
    expect(decidePeerKeysStatus({ canEncrypt: false, membersLoaded: false, memberCount: 3 })).toBe("unknown");
  });

  it("is missing once every profile loaded and someone still has no keys", () => {
    expect(decidePeerKeysStatus({ canEncrypt: false, membersLoaded: true, memberCount: 3 })).toBe("missing");
  });

  it("stays missing when the room crypto cannot tell whether profiles loaded", () => {
    expect(decidePeerKeysStatus({ canEncrypt: false, membersLoaded: undefined, memberCount: 2 })).toBe("missing");
  });

  it("is not-encrypted for rooms of 50 or more members", () => {
    expect(decidePeerKeysStatus({ canEncrypt: false, membersLoaded: false, memberCount: 50 })).toBe("not-encrypted");
  });
});
