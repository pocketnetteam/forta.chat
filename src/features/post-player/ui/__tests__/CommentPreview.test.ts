// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { PostComment } from "@/app/providers/initializers";

const loadCommentsByIds = vi.fn<(ids: string[]) => Promise<PostComment[]>>();
const users: Record<string, { name: string; image: string }> = {
  addrA: { name: "daniel_satchkov", image: "" },
  addrB: { name: "kleine", image: "" },
};
vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({
    loadCommentsByIds,
    loadUsersInfo: vi.fn().mockResolvedValue(undefined),
    getBastyonUserData: (addr: string) => users[addr] ?? null,
  }),
}));
vi.mock("@/shared/lib/image-url", () => ({ normalizePocketnetImageUrl: (x: string) => x }));
vi.mock("@/shared/lib/open-external-url", () => ({ openExternalUrl: vi.fn() }));
vi.mock("@/shared/lib/i18n", () => ({
  useI18n: () => ({ t: (k: string, p?: Record<string, string>) => (p?.name ? `${k}:${p.name}` : k) }),
}));

import CommentPreview from "../CommentPreview.vue";

const COMMENT = "c".repeat(64);
const PARENT = "d".repeat(64);

function makeComment(over: Partial<PostComment>): PostComment {
  return {
    id: COMMENT, postid: "p".repeat(64), parentid: "", answerid: "", address: "addrA",
    message: "hello", time: 1_700_000_000, scoreUp: 0, scoreDown: 0, ...over,
  };
}

const mountPreview = () => mount(CommentPreview, { props: { commentId: COMMENT, isOwn: false } });

describe("CommentPreview", () => {
  beforeEach(() => loadCommentsByIds.mockReset());

  it("loads the linked comment by id and shows its author and text", async () => {
    loadCommentsByIds.mockResolvedValueOnce([makeComment({ message: "Great post https://example.com" })]);
    const w = mountPreview();
    await flushPromises();

    expect(loadCommentsByIds).toHaveBeenCalledWith([COMMENT]);
    expect(w.text()).toContain("daniel_satchkov");
    expect(w.text()).toContain("Great post");
    expect(w.find("a").attributes("href")).toBe("https://example.com");
    expect(w.find("[data-testid=comment-preview-reply]").exists()).toBe(false);
  });

  it("shows the comment it answers, like Bastyon's comment preview", async () => {
    loadCommentsByIds
      .mockResolvedValueOnce([makeComment({ parentid: PARENT, answerid: PARENT })])
      .mockResolvedValueOnce([makeComment({ id: PARENT, address: "addrB", message: "question?" })]);
    const w = mountPreview();
    await flushPromises();

    expect(loadCommentsByIds).toHaveBeenLastCalledWith([PARENT]);
    const reply = w.find("[data-testid=comment-preview-reply]");
    expect(reply.text()).toContain("post.inReplyTo:kleine");
    expect(reply.text()).toContain("question?");
  });

  it("shows 'not found' when the node returns nothing", async () => {
    loadCommentsByIds.mockResolvedValueOnce([]);
    const w = mountPreview();
    await flushPromises();
    expect(w.text()).toContain("post.commentNotFound");
  });

  it("marks a deleted comment instead of an empty body", async () => {
    loadCommentsByIds.mockResolvedValueOnce([makeComment({ message: "", deleted: true })]);
    const w = mountPreview();
    await flushPromises();
    expect(w.text()).toContain("post.commentDeleted");
  });

  it("emits open on click (opens the post at the comment)", async () => {
    loadCommentsByIds.mockResolvedValueOnce([makeComment({})]);
    const w = mountPreview();
    await flushPromises();
    await w.find(".cursor-pointer").trigger("click");
    expect(w.emitted("open")).toHaveLength(1);
  });
});
