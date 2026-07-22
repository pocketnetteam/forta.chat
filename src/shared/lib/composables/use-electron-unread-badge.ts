import { watch, onScopeDispose } from "vue";
import { useChatStore } from "@/entities/chat";
import { getElectronAPI, isElectron } from "@/shared/lib/platform";

/**
 * Sync chatStore.totalUnread → Electron dock / taskbar badge.
 * No-op outside Electron.
 */
export function useElectronUnreadBadge(): void {
  if (!isElectron) return;

  const chatStore = useChatStore();
  const api = getElectronAPI();
  if (!api?.setBadgeCount) return;

  const stop = watch(
    () => chatStore.totalUnread,
    (count) => {
      void api.setBadgeCount(count);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    stop();
    void api.setBadgeCount(0);
  });
}
