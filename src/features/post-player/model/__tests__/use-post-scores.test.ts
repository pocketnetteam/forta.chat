import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BastyonPostData } from "@/app/providers/initializers";

const getCachedPost = vi.fn((_txid: string): BastyonPostData | null => null);
const loadMyPostScore = vi.fn(async (_txid: string): Promise<number | null> => null);
const submitUpvote = vi.fn(async (_txid: string, _value: number): Promise<boolean> => true);

vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({
    address: "PMyAddr",
    getCachedPost,
    loadMyPostScore,
    submitUpvote,
  }),
}));

import { usePostScores } from "../use-post-scores";

function makePost(txid: string, over: Partial<BastyonPostData> = {}): BastyonPostData {
  return {
    txid,
    address: "PAuthor",
    caption: "",
    message: "",
    images: [],
    url: "",
    tags: [],
    settings: {},
    time: 0,
    ...over,
  };
}

let seq = 0;
function uniqueTxid(): string {
  return `txid-${Date.now()}-${seq++}`;
}

describe("usePostScores", () => {
  beforeEach(() => {
    getCachedPost.mockReset().mockReturnValue(null);
    loadMyPostScore.mockReset().mockResolvedValue(null);
    submitUpvote.mockReset().mockResolvedValue(true);
  });

  it("derives average and total votes from the feed aggregate (scoreSum/scoreCnt)", async () => {
    const txid = uniqueTxid();
    getCachedPost.mockReturnValue(makePost(txid, { scoreSum: 10, scoreCnt: 2 }));

    const { averageScore, totalVotes, load } = usePostScores(txid);
    await load();

    expect(averageScore.value).toBe(5);
    expect(totalVotes.value).toBe(2);
  });

  it("does not fetch public scores (no getpostscores) — only the current user's vote", async () => {
    const txid = uniqueTxid();
    getCachedPost.mockReturnValue(makePost(txid, { scoreSum: 6, scoreCnt: 3 }));

    const store = (await import("@/entities/auth")).useAuthStore() as unknown as Record<string, unknown>;
    expect(store.loadPostScores).toBeUndefined();

    const { load } = usePostScores(txid);
    await load();

    expect(loadMyPostScore).toHaveBeenCalledTimes(1);
    expect(loadMyPostScore).toHaveBeenCalledWith(txid);
  });

  it("sets myScore / hasVoted from getpagescores", async () => {
    const txid = uniqueTxid();
    getCachedPost.mockReturnValue(makePost(txid, { scoreSum: 4, scoreCnt: 1 }));
    loadMyPostScore.mockResolvedValue(4);

    const { myScore, hasVoted, load } = usePostScores(txid);
    await load();

    expect(myScore.value).toBe(4);
    expect(hasVoted.value).toBe(true);
  });

  it("does not overwrite an optimistic vote with a null server value", async () => {
    const txid = uniqueTxid();
    getCachedPost.mockReturnValue(makePost(txid, { scoreSum: 0, scoreCnt: 0 }));
    loadMyPostScore.mockResolvedValue(null);

    const { myScore, submitVote, load } = usePostScores(txid);
    submitVote(5);
    await load();

    expect(myScore.value).toBe(5);
  });

  it("optimistically bumps the aggregate on submitVote and calls submitUpvote", async () => {
    const txid = uniqueTxid();
    getCachedPost.mockReturnValue(makePost(txid, { scoreSum: 10, scoreCnt: 2 }));

    const { averageScore, totalVotes, myScore, hasVoted, submitVote, load } = usePostScores(txid);
    await load();

    const ok = submitVote(5);

    expect(ok).toBe(true);
    expect(totalVotes.value).toBe(3);            // 2 + 1
    expect(averageScore.value).toBe(5);          // (10 + 5) / 3
    expect(myScore.value).toBe(5);
    expect(hasVoted.value).toBe(true);
    expect(submitUpvote).toHaveBeenCalledWith(txid, 5);
  });

  it("blocks a second vote once the user has voted", async () => {
    const txid = uniqueTxid();
    getCachedPost.mockReturnValue(makePost(txid, { scoreSum: 0, scoreCnt: 0 }));

    const { submitVote, load } = usePostScores(txid);
    await load();

    expect(submitVote(4)).toBe(true);
    expect(submitVote(2)).toBe(false);
    expect(submitUpvote).toHaveBeenCalledTimes(1);
  });
});
