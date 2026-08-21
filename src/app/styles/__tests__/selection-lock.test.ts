import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression for global text selection being selectable everywhere in the
 * chat UI (bubbles, avatars, timestamps, buttons) — accidental long-press /
 * drag selection was reported as constantly getting in the way. Selection is
 * now disabled globally via `body { user-select: none }` in main.css and
 * re-enabled only on message/publication body text via the Tailwind
 * `select-text` utility, applied at the specific text containers below.
 *
 * Source-level assertions mirror message-content-link-click.test.ts —
 * mounting each component needs Pinia + i18n + parser shims, which adds a
 * lot of brittleness for what is fundamentally a "is this class present on
 * this element" contract.
 */

const readSrc = (relPath: string): string =>
  readFileSync(resolve(__dirname, relPath), "utf-8");

describe("global selection lock (main.css)", () => {
  const css = readSrc("../main.css");

  it("disables selection globally on body", () => {
    const bodyBlock = css.match(/\bbody\s*\{[^}]*\}/);
    expect(bodyBlock).toBeTruthy();
    expect(bodyBlock![0]).toMatch(/user-select:\s*none/);
  });

  it("keeps text inputs / contenteditable areas selectable (composer, edit fields)", () => {
    const editableBlock = css.match(
      /input,\s*textarea,\s*\[contenteditable="true"\],\s*\[contenteditable=""\]\s*\{[^}]*\}/,
    );
    expect(editableBlock).toBeTruthy();
    expect(editableBlock![0]).toMatch(/user-select:\s*text/);
  });
});

describe("select-text applied to message/publication body text only", () => {
  it("MessageContent: both the block-embed and plain-inline text roots are selectable", () => {
    const src = readSrc("../../../features/messaging/ui/MessageContent.vue");
    expect(src).toMatch(/<div v-if="hasBlockSegments" class="select-text">/);
    expect(src).toMatch(/<div v-else class="select-text">/);
  });

  it("ChannelPostBubble: caption and body preview text are selectable", () => {
    const src = readSrc("../../../features/channels/ui/ChannelPostBubble.vue");
    expect(src).toMatch(/v-if="captionText"[\s\S]{0,40}class="select-text/);
    expect(src).toMatch(/v-if="bodyText"[\s\S]{0,40}class="select-text/);
  });

  it("PostCard: caption and truncated message are selectable", () => {
    const src = readSrc("../../../features/post-player/ui/PostCard.vue");
    expect(src).toMatch(/v-if="post\.caption"[\s\S]{0,40}class="select-text/);
    expect(src).toMatch(/v-if="truncatedMessage"[\s\S]{0,40}class="select-text/);
  });

  it("PostPlayerModal: caption heading and article body are selectable", () => {
    const src = readSrc("../../../features/post-player/ui/PostPlayerModal.vue");
    expect(src).toMatch(/<h2 v-if="post\.caption" class="select-text/);
    expect(src).toMatch(/<ArticleBody[\s\S]{0,120}class="select-text/);
  });

  it("PostComments: comment message text is selectable", () => {
    const src = readSrc("../../../features/post-player/ui/PostComments.vue");
    expect(src).toMatch(/<p class="select-text[^>]*>\{\{ comment\.message \}\}/);
  });

  it("AiChatView: chat bubble text (answer + reasoning) is selectable", () => {
    const src = readSrc("../../../features/ai-chat/ui/AiChatView.vue");
    expect(src).toMatch(/select-text[\s\S]{0,20}rounded-2xl px-3\.5 py-2 text-\[15px\]/);
  });

  it("ShowPrivateKeyDialog: the revealed private key text is selectable", () => {
    const src = readSrc("../../../features/user-management/ui/ShowPrivateKeyDialog.vue");
    expect(src).toMatch(/<p class="select-text break-all font-mono/);
  });
});
