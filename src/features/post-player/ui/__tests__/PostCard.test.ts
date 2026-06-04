import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

// Stub composables/stores BEFORE component import (vi.mock is hoisted).
const loadPost = vi.fn();
const getCachedPost = vi.fn(() => null);
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
vi.mock("@/shared/lib/video-embed", () => ({
  parseVideoUrl: () => null,
}));
vi.mock("@/shared/lib/image-url", () => ({
  normalizePocketnetImageUrl: (x: string) => x,
}));

vi.stubGlobal("useI18n", () => ({ t: (k: string) => k }));

import PostCard from "../PostCard.vue";

const POST_LOAD_TIMEOUT_MS = 15_000;

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
