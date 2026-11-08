import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "@/shared/lib/i18n/locales/en";
import { ru } from "@/shared/lib/i18n/locales/ru";

const bubble = readFileSync(resolve(__dirname, "../MessageBubble.vue"), "utf-8");
const icon = readFileSync(resolve(__dirname, "../MessageStatusIcon.vue"), "utf-8");
const contactList = readFileSync(resolve(__dirname, "../../../contacts/ui/ContactList.vue"), "utf-8");

/**
 * Tapping the red (!) on a failed own message shows why sending failed
 * (`message.sendError`). Source-level, matching the MessageBubble test style.
 */
describe("MessageBubble — send error behind the red (!)", () => {
  it("the failed icon is a button emitting failedClick only when clickable", () => {
    expect(icon).toMatch(/<button\s+v-else-if="isFailed && props\.clickableError"[\s\S]*?@click\.stop="emit\('failedClick'\)"/);
    expect(icon).toMatch(/failedClick: \[\];/);
  });

  it("every status icon in the bubble opens the error", () => {
    const icons = bubble.match(/<MessageStatusIcon [^>]*\/>/g) ?? [];
    expect(icons.length).toBeGreaterThan(0);
    for (const tag of icons) expect(tag).toMatch(/clickable-error @failed-click="toggleSendError"/);
  });

  it("chat-list preview keeps the plain icon (row stays clickable)", () => {
    expect(contactList).not.toMatch(/clickable-error/);
  });

  it("renders the stored error with an unknown-error fallback", () => {
    const block = bubble.match(/data-testid="send-error-details"[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(block).toMatch(/message\.sendError \|\| t\('message\.sendErrorUnknown'\)/);
    expect(bubble).toMatch(/v-if="isFailed && props\.isOwn && isSendErrorShown"/);
  });

  it("has the labels in both locales", () => {
    for (const key of ["message.sendErrorShow", "message.sendErrorTitle", "message.sendErrorUnknown"] as const) {
      expect(en[key]).toBeTruthy();
      expect(ru[key]).toBeTruthy();
    }
  });
});
