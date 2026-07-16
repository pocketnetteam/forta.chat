import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

// Stub composables/stores BEFORE component import (vi.mock is hoisted).
const loadPost = vi.fn();
const getCachedPost = vi.fn((): BastyonPostData | null => null);
vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({
    address: "myaddr",
    getCachedPost,
    loadPost,
    loadUsersInfo: vi.fn().mockResolvedValue(undefined),
    getBastyonUserData: () => null,
  }),
}));
vi.mock("@/entities/chat", () => ({
  useChatStore: () => ({ initPostForward: vi.fn() }),
}));
vi.mock("../model/use-post-scores", () => ({
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
vi.mock("../model/use-post-boost", () => ({
  usePostBoost: () => ({
    showDonateModal: { value: false },
    boostAddress: { value: "" },
    openBoost: vi.fn(),
    closeBoost: vi.fn(),
  }),
}));
vi.mock("@/shared/lib/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
// Mutable so a test can simulate a post that carries a recognized video URL.
let mockVideoInfo: unknown = null;
vi.mock("@/shared/lib/video-embed", () => ({
  parseVideoUrl: () => mockVideoInfo,
}));
vi.mock("@/shared/lib/image-url", () => ({
  normalizePocketnetImageUrl: (x: string) => x,
}));

vi.stubGlobal("useI18n", () => ({ t: (k: string) => k }));

import PostCard from "../PostCard.vue";
import type { BastyonPostData } from "@/app/providers/initializers";

const POST_LOAD_TIMEOUT_MS = 15_000;

const videoPost: BastyonPostData = {
  txid: "tx123",
  address: "author",
  caption: "clip",
  message: "",
  images: [],
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  tags: [],
  settings: {},
  time: 1_700_000_000,
};

const stubs = {
  VideoPlayer: true,
  StarRating: true,
  PostPlayerModal: true,
  DonateModal: true,
  PostCard: true,
};

function mountCard() {
  return mount(PostCard, {
    props: { txid: "tx123", isOwn: false },
    global: { stubs },
  });
}

describe("PostCard bounded skeleton + retry (WEE-70)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    loadPost.mockReset();
    getCachedPost.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("показывает skeleton пока loadPost в полёте", async () => {
    loadPost.mockReturnValue(new Promise(() => {})); // never resolves
    const w = mountCard();
    await flushPromises();

    // Skeleton present, no interactive error/retry controls yet.
    expect(w.find(".animate-pulse").exists()).toBe(true);
    expect(w.find("button").exists()).toBe(false);
  });

  it("при таймауте loadPost показывает ошибку + retry, а не вечный skeleton", async () => {
    loadPost.mockReturnValue(new Promise(() => {})); // hangs forever
    const w = mountCard();

    await vi.advanceTimersByTimeAsync(POST_LOAD_TIMEOUT_MS + 1);
    await flushPromises();

    // Skeleton is gone; error state with a not-found link + retry button shows.
    expect(w.find(".animate-pulse").exists()).toBe(false);
    expect(w.find("a").exists()).toBe(true);
    expect(w.find("button").exists()).toBe(true);
  });

  it("retry повторно вызывает loadPost", async () => {
    loadPost.mockReturnValue(new Promise(() => {}));
    const w = mountCard();

    await vi.advanceTimersByTimeAsync(POST_LOAD_TIMEOUT_MS + 1);
    await flushPromises();
    expect(loadPost).toHaveBeenCalledTimes(1);

    await w.find("button").trigger("click");
    await flushPromises();
    expect(loadPost).toHaveBeenCalledTimes(2);
  });
});

describe("PostCard unresolved repost fallback (WEE-101)", () => {
  const emptyRepostWrapper: BastyonPostData = {
    txid: "tx123",
    address: "sharer",
    caption: "",
    message: "",
    images: [],
    url: "",
    tags: [],
    settings: {},
    time: 1_700_000_000,
    repostUnresolved: true,
  };

  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    getCachedPost.mockReturnValue(null);
  });

  it("пустая обёртка с нерезолвнутым repost → fallback-ссылка, не голая карточка", async () => {
    getCachedPost.mockReturnValue(emptyRepostWrapper);
    const w = mountCard();
    await flushPromises();

    const link = w.find("a");
    expect(link.exists()).toBe(true);
    expect(link.text()).toBe("Open in Bastyon");
    // No bare card and no retry button (retry can't fix an unresolved repost).
    expect(w.find(".post-card").exists()).toBe(false);
    expect(w.find("button").exists()).toBe(false);
  });

  it("обёртка с разрешённым repost рендерит вложенный PostCard, а не fallback", async () => {
    getCachedPost.mockReturnValue({
      ...emptyRepostWrapper,
      repostUnresolved: undefined,
      repost: { ...emptyRepostWrapper, txid: "orig456", repostUnresolved: undefined },
    });
    const w = mountCard();
    await flushPromises();

    expect(w.find(".post-card").exists()).toBe(true);
    expect(w.findComponent({ name: "PostCard" }).exists()).toBe(true);
  });

  it("голая repost-обёртка не рендерит свои рейтинг/экшены/«Открыть» — только хедер + вложенный оригинал", async () => {
    getCachedPost.mockReturnValue({
      ...emptyRepostWrapper,
      repostUnresolved: undefined,
      repost: { ...emptyRepostWrapper, txid: "orig456", repostUnresolved: undefined },
    });
    const w = mountCard();
    await flushPromises();

    // Nested original card is there, the wrapper's own controls are not:
    // no buttons (open/share/boost) and no StarRating row of the wrapper.
    expect(w.findComponent({ name: "PostCard" }).exists()).toBe(true);
    expect(w.findAll("button").length).toBe(0);
    expect(w.findComponent({ name: "StarRating" }).exists()).toBe(false);
  });

  it("обёртка с собственным текстом сохраняет свои контролы при вложенном репосте", async () => {
    getCachedPost.mockReturnValue({
      ...emptyRepostWrapper,
      repostUnresolved: undefined,
      caption: "my hot take",
      repost: { ...emptyRepostWrapper, txid: "orig456", repostUnresolved: undefined },
    });
    const w = mountCard();
    await flushPromises();

    expect(w.findComponent({ name: "PostCard" }).exists()).toBe(true);
    expect(w.findAll("button").length).toBeGreaterThan(0);
  });

  it("обычный пост с контентом не задевается fallback'ом (регрессия)", async () => {
    getCachedPost.mockReturnValue({ ...emptyRepostWrapper, repostUnresolved: undefined, caption: "hello" });
    const w = mountCard();
    await flushPromises();

    expect(w.find(".post-card").exists()).toBe(true);
    expect(w.text()).toContain("hello");
  });
});

describe("PostCard channel feed video expand (WEE-74)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    getCachedPost.mockReturnValue(videoPost);
    mockVideoInfo = { type: "youtube", embedUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ" };
  });

  afterEach(() => {
    mockVideoInfo = null;
  });

  it("expand от inline-видео открывает пост-модалку (а не лочит ленту)", async () => {
    const w = mountCard();
    await flushPromises();

    // Cached post renders straight to the card with the inline VideoPlayer.
    const player = w.findComponent({ name: "VideoPlayer" });
    expect(player.exists()).toBe(true);
    expect(w.findComponent({ name: "PostPlayerModal" }).exists()).toBe(false);

    player.vm.$emit("expand");
    await flushPromises();

    // Playback is routed to the modal instead of embedding in the feed.
    expect(w.findComponent({ name: "PostPlayerModal" }).exists()).toBe(true);
  });
});
