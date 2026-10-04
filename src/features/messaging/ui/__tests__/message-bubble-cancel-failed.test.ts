import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "@/shared/lib/i18n/locales/en";
import { ru } from "@/shared/lib/i18n/locales/ru";

const bubble = readFileSync(resolve(__dirname, "../MessageBubble.vue"), "utf-8");
const list = readFileSync(resolve(__dirname, "../MessageList.vue"), "utf-8");

/**
 * A failed own text message offers «Отменить» next to «Нажмите для повтора»:
 * the user can drop a message that will never go through instead of leaving
 * it stuck in the chat. Source-level, matching the MessageBubble test style.
 */
describe("MessageBubble — cancel a failed text send", () => {
  const failedBar = bubble.match(/<!-- Failed text message: retry \/ cancel bar -->[\s\S]*?\n {8}<\/div>/)?.[0] ?? "";

  it("renders retry and cancel actions in the failed bar", () => {
    expect(failedBar).toMatch(/v-if="isFailed && props\.isOwn && !hasFileInfo"/);
    expect(failedBar).toMatch(/emit\('retryMessage', message\)/);
    expect(failedBar).toMatch(/data-testid="cancel-message"[\s\S]*?emit\('cancelMessage', message\)/);
    expect(failedBar).toMatch(/t\('message\.cancelSend'\)/);
  });

  it("declares the cancelMessage emit", () => {
    expect(bubble).toMatch(/cancelMessage: \[message: Message\];/);
  });

  it("wires the event to cancelFailedMessage in MessageList", () => {
    expect(list).toMatch(/@cancel-message="cancelFailedMessage"/);
    expect(list).toMatch(/cancelFailedMessage,[^}]*\} = useMessages\(\)/);
  });

  it("has the label in both locales", () => {
    expect(en["message.cancelSend"]).toBeTruthy();
    expect(ru["message.cancelSend"]).toBeTruthy();
  });
});
