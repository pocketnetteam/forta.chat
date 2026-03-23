import { shallowRef, ref, watch, onScopeDispose, type ShallowRef, type Ref } from "vue";
import { liveQuery } from "dexie";

export interface LiveQueryResult<T> {
  /** Reactive query data (starts as `initial`, updates on every DB change) */
  data: ShallowRef<T>;
  /** `false` until the first query result arrives; stays `true` across re-subscriptions */
  isReady: Ref<boolean>;
  /** Last error from the query, or null if the query is healthy */
  error: Ref<Error | null>;
}

/**
 * Vue 3 composable that wraps Dexie's liveQuery into a reactive ShallowRef.
 * Auto-subscribes to IndexedDB changes on the tables/indexes read by `querier`.
 * Unsubscribes on scope dispose. Re-subscribes when `deps` change.
 *
 * @param querier  Dexie query function (may be async)
 * @param deps     Optional reactive dependency getter — resubscribes on change
 * @param initial  Initial value before first query completes
 */
export function useLiveQuery<T>(
  querier: () => T | Promise<T>,
  deps?: () => unknown,
  initial?: T,
): LiveQueryResult<T> {
  const data = shallowRef<T>(initial as T) as ShallowRef<T>;
  const isReady = ref(false);
  const error = ref<Error | null>(null) as Ref<Error | null>;
  let subscription: { unsubscribe(): void } | null = null;
  let retryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1000;

  const subscribe = () => {
    subscription?.unsubscribe();
    // Do NOT reset isReady — stale data is better than a skeleton flash.
    // isReady stays true after the first emission so UI keeps showing
    // existing messages while the new query settles.
    const observable = liveQuery(querier);
    subscription = observable.subscribe({
      next: (value: T) => {
        data.value = value;
        isReady.value = true;
        error.value = null;
        retryCount = 0; // Reset on success
      },
      error: (err: unknown) => {
        console.error("[useLiveQuery] query error:", err);
        const wrapped = err instanceof Error ? err : new Error(String(err));

        if (retryCount < MAX_RETRIES) {
          retryCount++;
          const delay = BASE_DELAY_MS * Math.pow(2, retryCount - 1);
          console.warn(`[useLiveQuery] retrying (${retryCount}/${MAX_RETRIES}) in ${delay}ms`);
          retryTimer = setTimeout(() => {
            retryTimer = null;
            subscribe();
          }, delay);
        } else {
          error.value = wrapped;
        }
      },
    });
  };

  if (deps) {
    watch(deps, () => {
      retryCount = 0;
      error.value = null;
      subscribe();
    }, { immediate: true });
  } else {
    subscribe();
  }

  onScopeDispose(() => {
    subscription?.unsubscribe();
    subscription = null;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  });

  return { data, isReady, error };
}
