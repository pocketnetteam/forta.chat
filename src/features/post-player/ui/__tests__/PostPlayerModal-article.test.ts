import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

// Stub composables BEFORE component import (vi.mock is hoisted)
vi.mock("../../model/use-post-scores", () => ({
  usePostScores: () => ({
    myScore: { value: null },
    averageScore: { value: 0 },
    totalVotes: { value: 0 },
    hasVoted: { value: false },
    submitting: { value: false },
    load: vi.fn().mockResolvedValue(undefined),
    submitVote: vi.fn(),
  }),
}));
vi.mock("../../model/use-post-comments", () => ({
  usePostComments: () => ({
    comments: { value: [] },
    loading: { value: false },
    submitting: { value: false },
    load: vi.fn().mockResolvedValue(undefined),
    submit: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("../../model/use-post-boost", () => ({
  usePostBoost: () => ({
    showDonateModal: { value: false },
    boostAddress: { value: "" },
    openBoost: vi.fn(),
    closeBoost: vi.fn(),
  }),
}));
vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({ address: "myaddr" }),
}));
vi.mock("@/entities/chat", () => ({
  useChatStore: () => ({ initPostForward: vi.fn() }),
}));
vi.mock("@/shared/lib/video-embed", () => ({
  parseVideoUrl: () => null,
}));
vi.mock("@/shared/lib/image-url", () => ({
  normalizePocketnetImageUrl: (x: string) => x,
}));

vi.stubGlobal("useI18n", () => ({ t: (k: string) => k }));

import PostPlayerModal from "../PostPlayerModal.vue";

const articleJson = JSON.stringify({
  blocks: [
    { type: "paragraph", data: { text: "Первый <b>абзац</b>" } },
    { type: "header", data: { text: "Подзаголовок", level: 2 } },
    { type: "paragraph", data: { text: "Второй абзац" } },
  ],
});

interface FakePost {
  txid: string;
  caption: string;
  message: string;
  settings?: { v: string };
  time: number;
  address: string;
  tags: string[];
  url: string;
  images: string[];
}

const baseArticlePost: FakePost = {
  txid: "abc123",
  caption: "Заголовок",
  message: articleJson,
  settings: { v: "a" },
  time: 1700000000,
  address: "authoraddr",
  tags: [],
  url: "",
  images: [],
};

const stubs = {
  Teleport: true,
  VideoPlayer: true,
  StarRating: true,
  PostAuthor: true,
  PostActions: true,
  PostComments: true,
  DonateModal: true,
};

describe("PostPlayerModal article rendering", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("renders Editor.js blocks instead of raw JSON for article posts", () => {
    const w = mount(PostPlayerModal, {
      props: { post: baseArticlePost as never, authorName: "X", authorAvatarUrl: "" },
      global: { stubs },
    });
    const text = w.text();
    expect(text).not.toContain('"blocks":');
    expect(text).not.toContain('"type":"paragraph"');
    expect(text).toContain("Первый абзац");
    expect(text).toContain("Подзаголовок");
    expect(text).toContain("Второй абзац");
  });

  it("renders inline HTML safely (b tag kept, script dropped)", () => {
    const post = {
      ...baseArticlePost,
      message: JSON.stringify({
        blocks: [{ type: "paragraph", data: { text: "<b>safe</b><script>alert(1)</script>" } }],
      }),
    };
    const w = mount(PostPlayerModal, {
      props: { post: post as never, authorName: "X", authorAvatarUrl: "" },
      global: { stubs },
    });
    expect(w.html()).toContain("<b>safe</b>");
    expect(w.html().toLowerCase()).not.toContain("<script");
  });

  it("non-article post (settings.v != 'a') still renders message text", () => {
    const post = {
      ...baseArticlePost,
      settings: { v: "v" },
      message: "Plain text message",
    };
    const w = mount(PostPlayerModal, {
      props: { post: post as never, authorName: "X", authorAvatarUrl: "" },
      global: { stubs },
    });
    expect(w.text()).toContain("Plain text message");
  });
});
