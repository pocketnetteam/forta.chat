import { describe, it, expect, vi } from "vitest";
import { Pcrypto } from "../matrix-crypto";

/**
 * Regression: a room's crypto instance could not tell "keys not received yet"
 * from "the peer has no keys" — canBeEncrypt() is false in both, so opening a
 * chat while the key request was still in flight (or had timed out) showed
 * "Peer hasn't published encryption keys" for a peer that had them.
 * getKeysLoadState() exposes where the request stands; onKeysFailed lets the
 * app re-check instead of keeping a stale status.
 */

const ME = "6d65";
const PEER = "7065";

function makeChat(roomId: string) {
  return {
    roomId,
    getJoinedMemberCount: () => 2,
    currentState: { getStateEvents: () => [] },
    oldState: { getStateEvents: () => [] },
  };
}

function makePcrypto(getUsersInfo: (ids: string[]) => Promise<unknown[]>) {
  const pcrypto = new Pcrypto();
  pcrypto.init({ userinfo: { id: ME, keys: [] }, private: [] });
  pcrypto.setHelpers({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getUsersInfo: getUsersInfo as any,
    isTetatetChat: () => true,
    isChatPublic: () => false,
    matrixId: (id: string) => id,
  });
  return pcrypto;
}

describe("PcryptoRoomInstance.getKeysLoadState", () => {
  it("is 'loading' while the key request is in flight, then 'loaded'", async () => {
    let resolveKeys!: (v: unknown[]) => void;
    const pcrypto = makePcrypto(() => new Promise((r) => { resolveKeys = r; }));
    const onKeysLoaded = vi.fn();
    pcrypto.onKeysLoaded = onKeysLoaded;

    const prepared = pcrypto.addRoom(makeChat("!r:s"));
    await vi.waitFor(() => expect(pcrypto.rooms["!r:s"]).toBeDefined());
    expect(pcrypto.rooms["!r:s"].getKeysLoadState?.()).toBe("loading");

    resolveKeys([{ id: ME, keys: [] }, { id: PEER, keys: [] }]);
    await prepared;
    expect(pcrypto.rooms["!r:s"].getKeysLoadState?.()).toBe("loaded");
    expect(onKeysLoaded).toHaveBeenCalledWith("!r:s");
  });

  it("is 'failed' and fires onKeysFailed when the request fails", async () => {
    const pcrypto = makePcrypto(async () => { throw new Error("rpc down"); });
    const onKeysFailed = vi.fn();
    const onKeysLoaded = vi.fn();
    pcrypto.onKeysFailed = onKeysFailed;
    pcrypto.onKeysLoaded = onKeysLoaded;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await pcrypto.addRoom(makeChat("!r:s"));

    expect(pcrypto.rooms["!r:s"].getKeysLoadState?.()).toBe("failed");
    expect(onKeysFailed).toHaveBeenCalledWith("!r:s");
    expect(onKeysLoaded).not.toHaveBeenCalled();
  });

  it("a stale failure does not override a newer in-flight request", async () => {
    let call = 0;
    let rejectFirst!: (e: Error) => void;
    let resolveSecond!: (v: unknown[]) => void;
    const pcrypto = makePcrypto(() => {
      call++;
      return call === 1
        ? new Promise((_, rej) => { rejectFirst = rej; })
        : new Promise((res) => { resolveSecond = res; });
    });
    const onKeysFailed = vi.fn();
    pcrypto.onKeysFailed = onKeysFailed;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = pcrypto.addRoom(makeChat("!r:s"));
    await vi.waitFor(() => expect(call).toBe(1));
    const second = pcrypto.rooms["!r:s"].prepare();
    await vi.waitFor(() => expect(call).toBe(2));

    rejectFirst(new Error("old call timed out"));
    await first;
    expect(pcrypto.rooms["!r:s"].getKeysLoadState?.()).toBe("loading");
    expect(onKeysFailed).not.toHaveBeenCalled();

    resolveSecond([{ id: ME, keys: [] }, { id: PEER, keys: [] }]);
    await second;
    expect(pcrypto.rooms["!r:s"].getKeysLoadState?.()).toBe("loaded");
  });
});
