import { computed, getCurrentScope, onScopeDispose, ref, type Ref } from "vue";
import { useAuthStore } from "@/entities/auth";
import type { BastyonPostData } from "@/app/providers/initializers";

// Shared state per txid so PostCard and PostPlayerModal stay in sync.
// The average/vote-count come from the getprofilefeed aggregate
// (scoreSum/scoreCnt); only the current user's vote needs a network request.
type ScoreState = { myScore: Ref<number | null>; scoreSum: Ref<number>; scoreCnt: Ref<number>; seeded: Ref<boolean> };
const scoresCache = new Map<string, ScoreState>();
/** Live users (mounted PostCard / PostPlayerModal) per txid. */
const usersByTxid = new Map<string, number>();
/** Txids nobody shows, oldest first; only these can be evicted (W2D-02). */
const idle = new Set<string>();

/** Score states kept for posts nobody shows. Every post ever seen used to stay
 *  for the session (audit W2D-02); an entry in use is never evicted, so a card
 *  and the player modal of one post keep sharing it. */
export const POST_SCORES_IDLE_MAX = 500;

function acquire(txid: string): ScoreState {
  let state = scoresCache.get(txid);
  if (!state) {
    state = { myScore: ref<number | null>(null), scoreSum: ref(0), scoreCnt: ref(0), seeded: ref(false) };
    scoresCache.set(txid, state);
  }
  idle.delete(txid);
  usersByTxid.set(txid, (usersByTxid.get(txid) ?? 0) + 1);
  return state;
}

function release(txid: string): void {
  const users = (usersByTxid.get(txid) ?? 1) - 1;
  if (users > 0) {
    usersByTxid.set(txid, users);
    return;
  }
  usersByTxid.delete(txid);
  idle.add(txid);
  while (idle.size > POST_SCORES_IDLE_MAX) {
    const oldest = idle.values().next().value as string;
    idle.delete(oldest);
    scoresCache.delete(oldest);
  }
}

export function postScoresCacheSize(): number {
  return scoresCache.size;
}

export function resetPostScoresCacheForTests(): void {
  scoresCache.clear();
  usersByTxid.clear();
  idle.clear();
}

export function usePostScores(txid: string) {
  const authStore = useAuthStore();

  const cached = acquire(txid);
  if (getCurrentScope()) onScopeDispose(() => release(txid));
  const myScore = cached.myScore;
  const scoreSum = cached.scoreSum;
  const scoreCnt = cached.scoreCnt;

  const loading = ref(false);
  const submitting = ref(false);

  const averageScore = computed(() => (scoreCnt.value > 0 ? scoreSum.value / scoreCnt.value : 0));
  const totalVotes = computed(() => scoreCnt.value);
  const hasVoted = computed(() => myScore.value !== null && myScore.value > 0);

  /** Seed the aggregate once from the feed-provided post (scoreSum/scoreCnt). */
  const seedFromPost = (post?: BastyonPostData | null) => {
    if (cached.seeded.value || !post) return;
    scoreSum.value = Number(post.scoreSum ?? 0);
    scoreCnt.value = Number(post.scoreCnt ?? 0);
    if (post.myVal != null) myScore.value = Number(post.myVal);
    cached.seeded.value = true;
  };

  const load = async () => {
    // Aggregate is already known from the feed — no getpostscores request.
    seedFromPost(authStore.getCachedPost(txid));

    loading.value = true;
    try {
      const myVal = await authStore.loadMyPostScore(txid);
      // Don't overwrite an optimistic vote with a null/absent server value.
      if (myVal != null) myScore.value = myVal;
    } finally {
      loading.value = false;
    }
  };

  const submitVote = (value: number) => {
    if (hasVoted.value) return false;

    // Optimistic update — show rating immediately, blockchain confirms later
    myScore.value = value;
    scoreSum.value += value;
    scoreCnt.value += 1;

    // Fire-and-forget — don't revert on error (blockchain will catch up)
    console.log("[postScores] submitting vote:", txid, value);
    authStore.submitUpvote(txid, value)
      .then((ok) => console.log("[postScores] vote result:", txid, ok))
      .catch((e) => console.warn("[postScores] vote error:", txid, e));

    return true;
  };

  return { myScore, averageScore, totalVotes, hasVoted, loading, submitting, load, submitVote, seedFromPost };
}
