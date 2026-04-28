import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression tests for the "plaintext leak in encrypted 1:1 room" bug.
 *
 * Flow of the bug (pre-fix):
 *   1. SyncEngine picks up a pending send_message op.
 *   2. Calls roomCrypto.canBeEncrypt() — returns false because peer has
 *      not published their encryption keys yet (transient race during
 *      Matrix /sync), OR the chat is encrypted but the peer never will.
 *   3. Falls through to `matrixService.sendEncryptedText(roomId, { msgtype:
 *      "m.text", body: payload.content })` — a misleading name; this ships
 *      plaintext to the room.
 *   4. Peer (and anyone else joining later) sees the cleartext body.
 *
 * The fix requires a "requires encryption" signal on the PcryptoRoomInstance
 * so the sync engine can refuse to send plaintext when the room is private
 * (not public). Public / large rooms still send plaintext — that's the
 * Bastyon convention for open channels.
 *
 * Tests use source-level verification (matching the existing pattern in
 * matrix-crypto-can-be-encrypt.test.ts) because stubbing the full
 * Matrix/pcrypto harness is not worth the maintenance cost.
 */
const getMatrixCryptoSource = () =>
  readFileSync(
    resolve(__dirname, "../../../../entities/matrix/model/matrix-crypto.ts"),
    "utf-8",
  );

const getSyncEngineSource = () =>
  readFileSync(resolve(__dirname, "../sync-engine.ts"), "utf-8");

const getUseMessagesSource = () =>
  readFileSync(
    resolve(__dirname, "../../../../features/messaging/model/use-messages.ts"),
    "utf-8",
  );

describe("PcryptoRoomInstance.requiresEncryption — public-room discriminator", () => {
  it("declares requiresEncryption() on the interface", () => {
    const source = getMatrixCryptoSource();
    const ifaceIdx = source.indexOf("export interface PcryptoRoomInstance {");
    expect(ifaceIdx).toBeGreaterThan(-1);
    const ifaceEnd = source.indexOf("}", ifaceIdx);
    const section = source.slice(ifaceIdx, ifaceEnd);
    expect(section).toContain("requiresEncryption()");
  });

  it("implements requiresEncryption() on the per-room object", () => {
    const source = getMatrixCryptoSource();
    const roomIdx = source.indexOf("const room: PcryptoRoomInstance = {");
    expect(roomIdx).toBeGreaterThan(-1);
    const section = source.slice(roomIdx, roomIdx + 4000);
    expect(section).toContain("requiresEncryption(): boolean");
    // Must be true for non-public chats, false for public.
    // The simplest correct implementation is `return !publicChat` — the
    // test pins the negation against getIsChatPublic so the semantics
    // cannot silently invert.
    expect(section).toMatch(/requiresEncryption\(\):\s*boolean\s*{[\s\S]{0,600}getIsChatPublic/);
  });
});

describe("SyncEngine guards plaintext fallback in private rooms", () => {
  it("syncSendMessage throws instead of shipping plaintext when encryption is required", () => {
    const source = getSyncEngineSource();
    const fnIdx = source.indexOf("syncSendMessage(");
    expect(fnIdx).toBeGreaterThan(-1);
    // Take a generous slice to cover the encrypt/else branches.
    const end = source.indexOf("\n  private async syncSendFile", fnIdx);
    const section = source.slice(fnIdx, end > -1 ? end : fnIdx + 3000);

    // Must probe requiresEncryption before taking the plaintext branch.
    expect(section).toContain("requiresEncryption");
    // Must refuse rather than send plaintext when encryption is required
    // but canBeEncrypt() returned false. Shared tag keeps grep stable.
    expect(section).toContain("ENCRYPTION_REQUIRED_NO_KEYS");
  });

  it("syncSendFile guards attachments the same way", () => {
    const source = getSyncEngineSource();
    const fnIdx = source.indexOf("syncSendFile(");
    expect(fnIdx).toBeGreaterThan(-1);
    const end = source.indexOf("\n  private async syncEditMessage", fnIdx);
    const section = source.slice(fnIdx, end > -1 ? end : fnIdx + 3000);
    expect(section).toContain("requiresEncryption");
  });

  it("syncEditMessage guards edits the same way", () => {
    const source = getSyncEngineSource();
    const fnIdx = source.indexOf("syncEditMessage(");
    expect(fnIdx).toBeGreaterThan(-1);
    const end = source.indexOf("\n  private async syncDeleteMessage", fnIdx);
    const section = source.slice(fnIdx, end > -1 ? end : fnIdx + 3000);
    expect(section).toContain("requiresEncryption");
  });

  it("syncSendTransfer guards transfers the same way", () => {
    const source = getSyncEngineSource();
    const fnIdx = source.indexOf("syncSendTransfer(");
    expect(fnIdx).toBeGreaterThan(-1);
    const end = source.indexOf("\n  private async markMessageFailed", fnIdx);
    const section = source.slice(fnIdx, end > -1 ? end : fnIdx + 3000);
    expect(section).toContain("requiresEncryption");
  });
});

describe("use-messages legacy path guards plaintext fallback", () => {
  it("sendMessage legacy path refuses plaintext when encryption is required", () => {
    const source = getUseMessagesSource();
    // Locate the legacy sendText call (line ~254 in original, may shift).
    const legacyHeaderIdx = source.indexOf("// ── Legacy path");
    expect(legacyHeaderIdx).toBeGreaterThan(-1);
    const end = source.indexOf("/** Drain queued messages", legacyHeaderIdx);
    const section = source.slice(legacyHeaderIdx, end > -1 ? end : legacyHeaderIdx + 3000);
    expect(section).toContain("requiresEncryption");
  });

  it("offline drain path refuses plaintext when encryption is required", () => {
    const source = getUseMessagesSource();
    const fnIdx = source.indexOf("drainOfflineQueue");
    expect(fnIdx).toBeGreaterThan(-1);
    const end = source.indexOf("/** Send a file", fnIdx);
    const section = source.slice(fnIdx, end > -1 ? end : fnIdx + 3000);
    expect(section).toContain("requiresEncryption");
  });

  it("sendForward legacy path refuses plaintext when encryption is required", () => {
    const source = getUseMessagesSource();
    // The sendForward legacy fallback writes `{ body: trimmed, msgtype: "m.text" }`
    // then calls sendEncryptedText — effectively plaintext. Guard precedes it.
    const fnIdx = source.indexOf("[sendForward] Legacy path failed");
    expect(fnIdx).toBeGreaterThan(-1);
    // Walk backwards from the catch message to the start of the try block.
    const tryIdx = source.lastIndexOf("try {", fnIdx);
    const section = source.slice(tryIdx, fnIdx);
    expect(section).toContain("requiresEncryption");
  });

  it("editMessage legacy path refuses plaintext when encryption is required", () => {
    const source = getUseMessagesSource();
    const fnIdx = source.indexOf("const editMessage = async");
    expect(fnIdx).toBeGreaterThan(-1);
    const end = source.indexOf("const deleteMessage =", fnIdx);
    const section = source.slice(fnIdx, end > -1 ? end : fnIdx + 4000);
    expect(section).toContain("requiresEncryption");
  });

  it("forwardMessages (bulk forward) refuses plaintext when encryption is required", () => {
    const source = getUseMessagesSource();
    // Bulk-forward lives inside forwardMessages, identified by the
    // "Legacy fallback — direct encrypted/plaintext send to target room." marker.
    const fnIdx = source.indexOf("Legacy fallback — direct encrypted/plaintext send to target room");
    expect(fnIdx).toBeGreaterThan(-1);
    const section = source.slice(fnIdx, fnIdx + 2000);
    expect(section).toContain("requiresEncryption");
  });

  it("sendTransferMessage legacy path refuses plaintext when encryption is required", () => {
    const source = getUseMessagesSource();
    // Locate the legacy transfer fallback — the plain sendText below the
    // Dexie path fallback message. Transfer bodies carry recipient address
    // + txId so this is especially sensitive.
    const fnIdx = source.indexOf("const sendTransferMessage = async");
    expect(fnIdx).toBeGreaterThan(-1);
    const end = source.indexOf("const sendPoll =", fnIdx);
    const section = source.slice(fnIdx, end > -1 ? end : fnIdx + 4000);
    expect(section).toContain("requiresEncryption");
  });
});

describe("shared error tag ensures consistent log grep", () => {
  it("exports ENCRYPTION_REQUIRED_NO_KEYS from matrix-crypto", () => {
    const source = getMatrixCryptoSource();
    expect(source).toContain('export const ENCRYPTION_REQUIRED_NO_KEYS');
  });

  it("every sync-engine throw uses the shared tag", () => {
    const source = getSyncEngineSource();
    const throws = source.match(/throw new Error\(`\$\{ENCRYPTION_REQUIRED_NO_KEYS\}/g) ?? [];
    // One per sync path: syncSendMessage, syncSendFile, syncEditMessage, syncSendTransfer
    expect(throws.length).toBe(4);
  });

  it("every use-messages throw uses the shared tag", () => {
    const source = getUseMessagesSource();
    const throws = source.match(/throw new Error\(`\$\{ENCRYPTION_REQUIRED_NO_KEYS\}/g) ?? [];
    // sendMessage legacy, drainOfflineQueue, sendForward legacy, editMessage
    // legacy, forwardMessages bulk, sendTransferMessage legacy — 6 sites.
    expect(throws.length).toBe(6);
  });
});
