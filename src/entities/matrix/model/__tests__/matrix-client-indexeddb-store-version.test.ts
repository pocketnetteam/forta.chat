import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Pin the Matrix JS SDK's local IndexedDBStore name/version.
 *
 * Bumped v6 → v7 alongside disabling lazyLoadMembers (see
 * matrix-client-lazy-load-members.test.ts): an existing install's local
 * store was built while lazyLoadMembers was still true, so its cached room
 * member state can be incomplete. Disabling lazyLoadMembers only changes
 * what *future* /sync responses contain — it does not retroactively backfill
 * an already-populated local store, which is what left canBeEncrypt() seeing
 * an incomplete member set (the peer-keys-missing bug). Renaming the
 * IndexedDB database forces every client to rebuild its store from scratch
 * on next login, so the fix actually reaches existing installs.
 */
const getSource = (): string =>
  readFileSync(resolve(__dirname, "../matrix-client.ts"), "utf-8");

describe("matrix-client IndexedDBStore — version bump", () => {
  it("uses the matrix-js-sdk-v7 store name, not v6", () => {
    const source = getSource();
    expect(source).toContain('dbName: "matrix-js-sdk-v7:" + this.credentials.username');
    expect(source).not.toContain("matrix-js-sdk-v6");
  });
});
