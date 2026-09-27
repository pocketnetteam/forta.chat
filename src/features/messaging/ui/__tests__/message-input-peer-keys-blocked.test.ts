import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { en } from "@/shared/lib/i18n/locales/en";
import { ru } from "@/shared/lib/i18n/locales/ru";

/**
 * Audit S1-02 / forta-bugs#1332. In a 1:1 room whose peer has no published
 * encryption keys the banner promised "your messages will stay unencrypted",
 * but the send path never sends plaintext to a private room: Send is disabled
 * and Enter hit a bare `return` in handleSend — nothing happened at all, and
 * the promised unencrypted fallback never existed.
 */

const source = readFileSync(resolve(__dirname, "../MessageInput.vue"), "utf-8");

describe("MessageInput when the peer has no encryption keys (audit S1-02)", () => {
  it("tells the user why the message was not sent instead of returning silently", () => {
    const start = source.indexOf("const handleSend");
    const gate = source.indexOf("!peerKeysOk.value", start);
    expect(gate).toBeGreaterThan(start);
    const branch = source.slice(gate, source.indexOf("return;", gate) + "return;".length);
    expect(branch).toMatch(/toast\(\s*t\("chat\.peerKeysSendBlocked"\)\s*,\s*"error"/);
  });

  it("has the blocked-send message in both locales", () => {
    expect(en["chat.peerKeysSendBlocked"]).toBeTruthy();
    expect(ru["chat.peerKeysSendBlocked"]).toBeTruthy();
  });

  it("no longer promises that messages go out unencrypted", () => {
    expect(en["chat.peerKeysMissing"]).not.toMatch(/unencrypted/i);
    expect(ru["chat.peerKeysMissing"]).not.toMatch(/без шифрования/i);
  });
});
