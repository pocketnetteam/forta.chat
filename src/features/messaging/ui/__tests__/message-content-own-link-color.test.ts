// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

/** Links and mentions in own bubbles used the accent colour — the same colour
 *  as the bubble, so they read as blue on blue. */
vi.mock("@/entities/chat", () => ({ useChatStore: () => ({ getLocalAlias: () => null }) }));
vi.mock("@/features/post-player", () => ({ PostCard: { template: "<div />" } }));
vi.mock("@/features/collection-preview", () => ({ CollectionCard: { template: "<div />" } }));
vi.mock("@/features/bastyon-link-preview", () => ({
  ProfileLinkCard: { template: "<div />" },
  RoomLinkCard: { template: "<div />" },
  TransactionLinkCard: { template: "<div />" },
}));

import MessageContent from "../MessageContent.vue";

const MENTION = `@${"a".repeat(34)}:Daniel`;
const text = `See http://Rocket.Chat and ${MENTION}`;

describe("MessageContent link colour", () => {
  it("uses the near-white link token in own bubbles", () => {
    const w = mount(MessageContent, { props: { text, isOwn: true } });
    expect(w.find("a").classes()).toContain("text-chat-link-own");
    expect(w.find("a").classes()).not.toContain("text-color-txt-ac");
    expect(w.find("span.cursor-pointer").classes()).toContain("text-chat-link-own");
  });

  it("keeps the accent colour in other people's bubbles", () => {
    const w = mount(MessageContent, { props: { text, isOwn: false } });
    expect(w.find("a").classes()).toContain("text-color-txt-ac");
    expect(w.find("span.cursor-pointer").classes()).toContain("text-color-txt-ac");
  });
});
