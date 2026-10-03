// @vitest-environment happy-dom
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

const { openExternalUrl } = vi.hoisted(() => ({ openExternalUrl: vi.fn() }));
vi.mock("@/shared/lib/open-external-url", () => ({ openExternalUrl }));

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
  CommentPreview: true,
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

  it("fallback-ссылка ведёт на https://bastyon.com и открывается через openExternalUrl", async () => {
    openExternalUrl.mockReset();
    getCachedPost.mockReturnValue(emptyRepostWrapper);
    const w = mountCard();
    await flushPromises();

    const link = w.find("a");
    expect(link.attributes("href")).toBe("https://bastyon.com/post?s=tx123");
    await link.trigger("click");
    expect(openExternalUrl).toHaveBeenCalledWith("https://bastyon.com/post?s=tx123");
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

describe("PostCard message links", () => {
  const textPost: BastyonPostData = {
    ...videoPost,
    url: "",
    caption: "",
    message: "Details at https://example.com/article and more",
  };

  beforeEach(() => {
    setActivePinia(createPinia());
    mockVideoInfo = null;
    openExternalUrl.mockReset();
    getCachedPost.mockReturnValue(textPost);
  });

  it("renders URLs in the post text as highlighted links", async () => {
    const w = mountCard();
    await flushPromises();
    const link = w.find('a[href="https://example.com/article"]');
    expect(link.exists()).toBe(true);
    expect(link.text()).toBe("https://example.com/article");
    expect(w.text()).toContain("Details at");
    expect(w.text()).toContain("and more");
  });

  it("opens the link externally and does not bubble to the bubble/card", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const onParentClick = vi.fn();
    host.addEventListener("click", onParentClick);
    const w = mount(PostCard, {
      props: { txid: "tx123", isOwn: false },
      global: { stubs },
      attachTo: host,
    });
    await flushPromises();
    await w.find('a[href="https://example.com/article"]').trigger("click");
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/article");
    expect(onParentClick).not.toHaveBeenCalled();
    w.unmount();
    host.remove();
  });

  it("keeps the full href when the preview truncates through a link", async () => {
    const longUrl = `https://example.com/${"a".repeat(300)}`;
    getCachedPost.mockReturnValue({ ...textPost, message: `x ${longUrl}` });
    const w = mountCard();
    await flushPromises();
    const link = w.find("a[href^='https://example.com/']");
    expect(link.attributes("href")).toBe(longUrl);
    expect(link.text().endsWith("...")).toBe(true);
  });
});

describe("PostCard comment link and repost frame", () => {
  const textPost: BastyonPostData = { ...videoPost, url: "", caption: "Title", message: "text" };

  beforeEach(() => {
    setActivePinia(createPinia());
    mockVideoInfo = null;
    getCachedPost.mockReturnValue(textPost);
  });

  afterEach(() => {
    getCachedPost.mockReturnValue(null);
  });

  it("a comment link shows the comment and a 'go to comment' button instead of 'open post'", async () => {
    const w = mount(PostCard, {
      props: { txid: "tx123", isOwn: false, initialCommentId: "c".repeat(64) },
      global: { stubs },
    });
    await flushPromises();

    expect(w.findComponent({ name: "CommentPreview" }).props("commentId")).toBe("c".repeat(64));
    const buttons = w.findAll("button").map((b) => b.text());
    expect(buttons).toContain("Go to comment");
    expect(buttons).not.toContain("Open");
  });

  it("a plain post link keeps 'open post' and no comment block", async () => {
    const w = mountCard();
    await flushPromises();

    expect(w.findComponent({ name: "CommentPreview" }).exists()).toBe(false);
    expect(w.findAll("button").map((b) => b.text())).toContain("Open");
  });

  it("a repost nests the original as an embedded card without an extra frame around it", async () => {
    getCachedPost.mockReturnValue({ ...textPost, repost: { ...textPost, txid: "orig456" } });
    const w = mountCard();
    await flushPromises();

    const nested = w.find("post-card-stub");
    expect(nested.attributes("txid")).toBe("orig456");
    expect(nested.attributes()).toHaveProperty("embedded");
    expect(nested.element.parentElement?.className).not.toMatch(/border/);
  });

  it("an embedded card fills its parent instead of the fixed bubble width", async () => {
    const w = mount(PostCard, { props: { txid: "tx123", isOwn: false, embedded: true }, global: { stubs } });
    await flushPromises();

    const classes = w.find(".post-card").classes();
    expect(classes).toContain("w-full");
    expect(classes).not.toContain("my-1.5");
  });
});
