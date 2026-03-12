import { useAuthStore } from "@/entities/auth";
import type { PostScore } from "@/app/providers/initializers";

export function usePostScores(txid: string) {
  const authStore = useAuthStore();
  const scores = ref<PostScore[]>([]);
  const myScore = ref<number | null>(null);
  const loading = ref(false);
  const submitting = ref(false);

  const averageScore = computed(() => {
    if (scores.value.length === 0) return 0;
    const sum = scores.value.reduce((acc, s) => acc + s.value, 0);
    return sum / scores.value.length;
  });

  const totalVotes = computed(() => scores.value.length);
  const hasVoted = computed(() => myScore.value !== null && myScore.value > 0);

  const load = async () => {
    loading.value = true;
    try {
      const [scoresData, myVal] = await Promise.all([
        authStore.loadPostScores(txid),
        authStore.loadMyPostScore(txid),
      ]);
      scores.value = scoresData;
      myScore.value = myVal;
    } finally {
      loading.value = false;
    }
  };

  const submitVote = async (value: number) => {
    if (hasVoted.value || submitting.value) return false;

    // Optimistic update — show rating immediately, don't wait for blockchain
    const prevMyScore = myScore.value;
    const prevScores = scores.value;
    myScore.value = value;
    scores.value = [...scores.value, { address: authStore.address!, value, posttxid: txid }];

    // Fire API call in background
    authStore.submitUpvote(txid, value).then((ok) => {
      if (!ok) {
        // Revert on failure
        myScore.value = prevMyScore;
        scores.value = prevScores;
      }
    }).catch(() => {
      myScore.value = prevMyScore;
      scores.value = prevScores;
    });

    return true;
  };

  return { scores, myScore, averageScore, totalVotes, hasVoted, loading, submitting, load, submitVote };
}
