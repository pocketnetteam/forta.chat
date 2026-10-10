import { ref, watch, onUnmounted, type Ref } from "vue";
import { withTimeout } from "@/shared/lib/with-timeout";
import { summarizeTransaction, type TransactionSummary } from "./transaction-summary";

/** Nodes aren't in sync: a transaction broadcast through the sender's node can
 *  take a while to reach ours. So the card keeps asking — first after a short
 *  pause (a just-sent link usually arrives before the transaction propagates),
 *  then every POLL_INTERVAL_MS until POLL_WINDOW_MS has passed. A mempool hit
 *  (no block yet) keeps polling inside the same window to pick up its block. */
export const FIRST_ATTEMPT_DELAY_MS = 3_000;
export const POLL_INTERVAL_MS = 15_000;
export const POLL_WINDOW_MS = 5 * 60_000;
/** One RPC may hang on a slow network (Tor); it then counts as a miss. */
const ATTEMPT_TIMEOUT_MS = 15_000;

/** `update` bypasses the loader's own cache (psdk) — set on every re-poll. */
type LoadRaw = (txid: string, update: boolean) => Promise<unknown>;

/** Mined transactions never change: a card re-mounted by the virtual scroller
 *  shows them at once instead of waiting out the first-attempt delay again. */
const minedCache = new Map<string, TransactionSummary>();

/** Test hook. */
export function clearTransactionLoaderCache(): void {
  minedCache.clear();
}

export function useTransactionLoader(txid: Ref<string>, loadRaw: LoadRaw) {
  const summary = ref<TransactionSummary | null>(null);
  /** True while still waiting for the first sighting (window not over). */
  const loading = ref(true);

  // Each start() bumps the generation; timers and responses of an older
  // generation (previous txid, retry, unmount) are dropped.
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  async function attempt(gen: number, deadline: number, update: boolean): Promise<void> {
    timer = null;
    let result: TransactionSummary | null = null;
    try {
      result = summarizeTransaction(await withTimeout(loadRaw(txid.value, update), ATTEMPT_TIMEOUT_MS, "loadTransaction"));
    } catch {
      // "No such transaction" on this node, or a network failure — retry below.
    }
    if (gen !== generation) return;

    if (result) summary.value = result;
    if (result?.height) minedCache.set(result.txid, result);
    const done = !!summary.value?.height;
    const canRetry = Date.now() + POLL_INTERVAL_MS <= deadline;
    if (!done && canRetry) {
      timer = setTimeout(() => void attempt(gen, deadline, true), POLL_INTERVAL_MS);
      return;
    }
    loading.value = false;
  }

  /** (Re)start the polling window — on mount, a new txid or a manual retry
   *  (`fresh`: skip any cached answer on the first call too). */
  function start(firstDelay = FIRST_ATTEMPT_DELAY_MS, fresh = false) {
    const gen = ++generation;
    clearTimer();
    const cached = minedCache.get(txid.value);
    if (cached) {
      summary.value = cached;
      loading.value = false;
      return;
    }
    // A recheck of the same txid keeps what is already shown (a mempool hit),
    // so a failing node can't turn it back into "not found".
    if (summary.value?.txid !== txid.value) summary.value = null;
    loading.value = true;
    const deadline = Date.now() + POLL_WINDOW_MS;
    timer = setTimeout(() => void attempt(gen, deadline, fresh), firstDelay);
  }

  watch(txid, () => start());
  onUnmounted(() => {
    generation++;
    clearTimer();
  });

  return { summary, loading, start };
}
