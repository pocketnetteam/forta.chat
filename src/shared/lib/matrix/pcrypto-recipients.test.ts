import { describe, it, expect } from "vitest";
import { hexEncode } from "./functions";
import { addressFromMatrixId, eventKeyAddresses, pcryptoRecipientHexIds } from "./pcrypto-recipients";

const ME = "PMeAddress111";
const PEER = "PPeerAddress22";
const meHex = hexEncode(ME).toLowerCase();
const peerHex = hexEncode(PEER).toLowerCase();

const b64Json = (obj: unknown) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
const secrets = { [meHex]: { encrypted: "x", nonce: "y" }, [peerHex]: { encrypted: "x", nonce: "y" } };

describe("pcryptoRecipientHexIds", () => {
  it("reads the recipients of a 1:1 text message", () => {
    const raw = { type: "m.room.message", content: { msgtype: "m.encrypted", body: b64Json(secrets) } };
    expect(pcryptoRecipientHexIds(raw).sort()).toEqual([meHex, peerHex].sort());
  });

  it("reads the recipients of a file's secrets and of a common-key event", () => {
    const file = { type: "m.room.message", content: { msgtype: "m.file", info: { secrets: { keys: b64Json(secrets) } } } };
    // Real common-key events carry the users hash next to the keys.
    const key = { type: "m.room.encryption", content: { version: 2, hash: "h", block: 10, keys: b64Json(secrets) } };
    expect(pcryptoRecipientHexIds(file)).toHaveLength(2);
    expect(pcryptoRecipientHexIds(key)).toHaveLength(2);
  });

  it("returns [] for group messages, plaintext and garbage", () => {
    expect(pcryptoRecipientHexIds({ content: { msgtype: "m.encrypted", hash: "h", body: "abc" } })).toEqual([]);
    expect(pcryptoRecipientHexIds({ content: { msgtype: "m.text", body: "hello" } })).toEqual([]);
    expect(pcryptoRecipientHexIds({ content: { msgtype: "m.encrypted", body: "%%%not base64" } })).toEqual([]);
    expect(pcryptoRecipientHexIds({ content: { msgtype: "m.encrypted", body: b64Json(["array"]) } })).toEqual([]);
    expect(pcryptoRecipientHexIds(null)).toEqual([]);
  });
});

describe("addressFromMatrixId", () => {
  it("decodes a Matrix user id and a bare hex id", () => {
    expect(addressFromMatrixId(`@${peerHex}:matrix.server`)).toBe(PEER);
    expect(addressFromMatrixId(peerHex)).toBe(PEER);
  });

  it("rejects ids that are not hex-encoded addresses", () => {
    expect(addressFromMatrixId("@peer:s")).toBeNull();
    expect(addressFromMatrixId("")).toBeNull();
    expect(addressFromMatrixId(undefined)).toBeNull();
  });
});

describe("eventKeyAddresses", () => {
  it("collects senders and recipients, deduplicated, without the excluded address", () => {
    const own = { sender: `@${meHex}:s`, content: { msgtype: "m.encrypted", body: b64Json(secrets) } };
    const group = { sender: `@${peerHex}:s`, content: { msgtype: "m.encrypted", hash: "h", body: "ff" } };
    expect(eventKeyAddresses([own, group, null], ME)).toEqual([PEER]);
  });

  it("finds the peer in one's own 1:1 message — the member list may not have them", () => {
    const own = { sender: `@${meHex}:s`, content: { msgtype: "m.encrypted", body: b64Json(secrets) } };
    expect(eventKeyAddresses([own], ME)).toEqual([PEER]);
  });
});
