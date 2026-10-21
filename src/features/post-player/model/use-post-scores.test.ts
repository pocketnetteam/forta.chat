import { describe, it, expect, vi, beforeEach } from "vitest";
import { effectScope } from "vue";

/**
 * Audit W2D-02: every post ever shown kept its score state for the session.
 * The cache is now capped, but only entries nobody shows can go: a card and
 * the player modal of the same post must keep sharing one state (a vote cast
 * in one shows in the other), so an entry in use is never evicted.
 */
vi.mock("@/entities/auth", () => ({
  useAuthStore: () => ({ getCachedPost: () => null, loadMyPostScore: async () => null, submitUpvote: async () => true }),
}));

import { POST_SCORES_IDLE_MAX, postScoresCacheSize, resetPostScoresCacheForTests, usePostScores } from "./use-post-scores";

describe("usePostScores cache (audit W2D-02)", () => {
  beforeEach(() => resetPostScoresCacheForTests());

  it("keeps at most POST_SCORES_IDLE_MAX entries nobody shows", () => {
    for (let i = 0; i < POST_SCORES_IDLE_MAX + 25; i++) {
      const scope = effectScope();
      scope.run(() => usePostScores(`tx-${i}`));
      scope.stop();
    }
    expect(postScoresCacheSize()).toBe(POST_SCORES_IDLE_MAX);
  });

  it("never evicts an entry still shown, and its users keep sharing one state", () => {
    const card = effectScope();
    const shown = card.run(() => usePostScores("tx-shown"))!;
    for (let i = 0; i < POST_SCORES_IDLE_MAX + 25; i++) {
      const scope = effectScope();
      scope.run(() => usePostScores(`tx-${i}`));
      scope.stop();
    }
    const modal = effectScope();
    const again = modal.run(() => usePostScores("tx-shown"))!;
    expect(shown.submitVote(5)).toBe(true);
    expect(again.myScore.value).toBe(5);
    expect(again.hasVoted.value).toBe(true);
    card.stop();
    modal.stop();
  });

  it("brings back an idle entry's state when the post shows again before eviction", () => {
    const first = effectScope();
    first.run(() => usePostScores("tx-back"))!.submitVote(4);
    first.stop();
    const second = effectScope();
    const back = second.run(() => usePostScores("tx-back"))!;
    expect(back.myScore.value).toBe(4);
    second.stop();
  });
});
