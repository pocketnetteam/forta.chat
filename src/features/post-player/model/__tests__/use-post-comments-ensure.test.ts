import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PostComment } from "@/app/providers/initializers";

/** "Go to comment" from a shared link: the post's list holds only top-level
 *  comments, so a linked reply is loaded by id and put after its parent. */

const loadPostComments = vi.fn<(txid: string) => Promise<PostComment[]>>();
const loadCommentsByIds = vi.fn<(ids: string[]) => Promise<PostComment[]>>();
vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({ address: "me", loadPostComments, loadCommentsByIds }),
}));

import { usePostComments } from "../use-post-comments";

const c = (id: string, over: Partial<PostComment> = {}): PostComment => ({
  id, postid: "post", parentid: "", answerid: "", address: "a", message: id,
  time: 0, scoreUp: 0, scoreDown: 0, ...over,
});

describe("usePostComments.ensureComment", () => {
  beforeEach(() => {
    loadPostComments.mockReset().mockResolvedValue([c("top1"), c("top2"), c("top3")]);
    loadCommentsByIds.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("inserts a linked reply right after the comment it answers", async () => {
    loadCommentsByIds.mockResolvedValue([c("reply", { parentid: "top2", answerid: "top2" })]);
    const { comments, load, ensureComment } = usePostComments("post");
    await load();
    await ensureComment("reply");

    expect(loadCommentsByIds).toHaveBeenCalledWith(["reply"]);
    expect(comments.value.map((x) => x.id)).toEqual(["top1", "top2", "reply", "top3"]);
  });

  it("does not refetch a comment already in the list", async () => {
    const { comments, load, ensureComment } = usePostComments("post");
    await load();
    await ensureComment("top1");

    expect(loadCommentsByIds).not.toHaveBeenCalled();
    expect(comments.value).toHaveLength(3);
  });

  it("appends when the parent is not loaded and skips deleted or missing comments", async () => {
    const { comments, load, ensureComment } = usePostComments("post");
    await load();

    loadCommentsByIds.mockResolvedValueOnce([c("orphan", { parentid: "elsewhere" })]);
    await ensureComment("orphan");
    expect(comments.value.at(-1)?.id).toBe("orphan");

    loadCommentsByIds.mockResolvedValueOnce([c("gone", { deleted: true })]);
    await ensureComment("gone");
    loadCommentsByIds.mockResolvedValueOnce([]);
    await ensureComment("missing");
    expect(comments.value.map((x) => x.id)).toEqual(["top1", "top2", "top3", "orphan"]);
  });
});
