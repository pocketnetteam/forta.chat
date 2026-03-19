import { ref, computed, watch, type Ref, type ComputedRef } from "vue";
import { useSyncStatus } from "./use-sync-status";

export interface ChatSyncReturn {
  isFresh: Readonly<Ref<boolean>>;
  syncSubtitle: ComputedRef<string | null>;
}

export function useChatSyncStatus(roomId: Ref<string | null>): ChatSyncReturn {
  const { rawStatus } = useSyncStatus();
  const isFresh = ref(false);

  watch(roomId, () => {
    isFresh.value = rawStatus.value === "up_to_date";
  });

  watch(rawStatus, (next) => {
    if (next === "up_to_date" && roomId.value) {
      isFresh.value = true;
    }
    if (next === "catching_up" || next === "offline" || next === "error") {
      isFresh.value = false;
    }
  });

  const syncSubtitle = computed<string | null>(() => {
    if (isFresh.value) return null;

    switch (rawStatus.value) {
      case "catching_up":
      case "connecting": return "Обновление...";
      case "offline": return "Ожидание сети...";
      case "error": return "Нет соединения";
      default: return null;
    }
  });

  return { isFresh, syncSubtitle };
}
