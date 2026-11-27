import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Source contract: MessageInput must not focus the composer when
 * forwardingMessage is merely set (picker still open). Caption focus is
 * gated on showForwardPreview / showBulkForwardPreview becoming true.
 */
describe("MessageInput — forward caption focus (policy 1A)", () => {
  const source = readFileSync(
    resolve(__dirname, "../MessageInput.vue"),
    "utf-8",
  );

  it("does not watch forwardingMessage for autofocus", () => {
    expect(source).not.toMatch(
      /watch\(\s*\(\)\s*=>\s*chatStore\.forwardingMessage[\s\S]*?requestFocus/,
    );
    expect(source).not.toMatch(
      /watch\(\s*\(\)\s*=>\s*chatStore\.forwardingMessage[\s\S]*?\.focus\(/,
    );
  });

  it("focuses caption when forward preview becomes visible", () => {
    expect(source).toMatch(
      /watch\(\s*\[showForwardPreview,\s*showBulkForwardPreview\]/,
    );
    expect(source).toContain('"composer-forward-caption"');
  });

  it("routes edit/reply/emoji through the keyboard owner", () => {
    expect(source).toContain('"composer-edit"');
    expect(source).toContain('"composer-reply"');
    expect(source).toContain('"composer-emoji-restore"');
    expect(source).toContain('releaseFocus("picker"');
  });
});
