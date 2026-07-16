import { watch } from "vue";
import { useChatStore } from "@/entities/chat";
import { tRaw } from "@/shared/lib/i18n";
import { applyAppDocumentTitle } from "@/shared/lib/notifications/document-title";

/**
 * Keeps document.title in sync with chatStore.totalUnread:
 * "(5) Forta Chat" when there are unreads, otherwise "Forta Chat".
 */
export function useUnreadDocumentTitle(): void {
  const chatStore = useChatStore();

  watch(
    () => chatStore.totalUnread,
    (unread) => {
      applyAppDocumentTitle(unread, tRaw("titleBar.appName"));
    },
    { immediate: true },
  );
}
