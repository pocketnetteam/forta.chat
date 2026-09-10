import { computed, ref, type ComputedRef, type Ref } from "vue";

export interface HistoryPaginationDeps {
  getActiveRoomId: () => string | null;
  /** Grow the local (Dexie) window; resolves true if Dexie filled it. */
  expandWindow: () => Promise<boolean>;
  /** Network scrollback that also persists to Dexie; false = nothing new. */
  loadMoreRemote: (roomId: string) => Promise<boolean>;
  /** Background scrollback one batch ahead; false = nothing new. */
  prefetchRemote: (roomId: string) => Promise<boolean>;
}

export interface HistoryPagination {
  hasMoreLocal: Ref<boolean>;
  hasMoreRemote: Ref<boolean>;
  canLoadMore: ComputedRef<boolean>;
  loadingMore: Ref<boolean>;
  networkWaiting: Ref<boolean>;
  reset: () => void;
  startPrefetch: (roomId: string) => void;
  loadMore: (roomId: string) => Promise<void>;
}

/**
 * Scroll-up pagination state for the message list.
 *
 * "More local history" (rows in Dexie beyond the current window) and "more
 * remote history" (server scrollback) are tracked separately. A single
 * `hasMore` flag used to take the prefetch/scrollback result, so an empty
 * scrollback — SDK timeline already fully paginated, or one network error —
 * stopped scroll-up entirely even with the whole history sitting in Dexie.
 * Pagination now continues while either source may have more.
 *
 * Every async result is dropped if the room changed meanwhile (generation
 * bumped by reset()): a late prefetch of the previous room must not switch
 * off pagination in the new one.
 */
export function useHistoryPagination(deps: HistoryPaginationDeps): HistoryPagination {
  const hasMoreLocal = ref(true);
  const hasMoreRemote = ref(true);
  const loadingMore = ref(false);
  const networkWaiting = ref(false);
  const canLoadMore = computed(() => hasMoreLocal.value || hasMoreRemote.value);
  let generation = 0;

  const isCurrent = (gen: number, roomId: string): boolean =>
    gen === generation && deps.getActiveRoomId() === roomId;

  const reset = (): void => {
    generation++;
    hasMoreLocal.value = true;
    hasMoreRemote.value = true;
    loadingMore.value = false;
    networkWaiting.value = false;
  };

  const startPrefetch = (roomId: string): void => {
    const gen = generation;
    deps.prefetchRemote(roomId)
      .then((more) => { if (isCurrent(gen, roomId)) hasMoreRemote.value = more; })
      .catch(() => {});
  };

  const loadMore = async (roomId: string): Promise<void> => {
    if (loadingMore.value || !canLoadMore.value) return;
    const gen = generation;
    loadingMore.value = true;
    try {
      // Always try the local window first: a prefetch or an earlier network
      // page may have landed rows since the last time Dexie looked exhausted.
      const localFilled = await deps.expandWindow();
      if (!isCurrent(gen, roomId)) return;
      hasMoreLocal.value = localFilled;

      if (!localFilled && hasMoreRemote.value) {
        networkWaiting.value = true;
        const more = await deps.loadMoreRemote(roomId);
        if (!isCurrent(gen, roomId)) return;
        hasMoreRemote.value = more;
        if (more) {
          const filledAfterNetwork = await deps.expandWindow();
          if (!isCurrent(gen, roomId)) return;
          hasMoreLocal.value = filledAfterNetwork;
        }
      }

      if (hasMoreRemote.value) startPrefetch(roomId);
    } catch (e) {
      console.warn("[history-pagination] loadMore failed:", e);
    } finally {
      if (gen === generation) {
        loadingMore.value = false;
        networkWaiting.value = false;
      }
    }
  };

  return { hasMoreLocal, hasMoreRemote, canLoadMore, loadingMore, networkWaiting, reset, startPrefetch, loadMore };
}
