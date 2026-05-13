import { onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { App as CapApp } from "@capacitor/app";
import type { PluginListenerHandle } from "@capacitor/core";
import { isNative } from "@/shared/lib/platform";
import { useAuthStore } from "@/entities/auth";
import { useCallStore } from "@/entities/call";

// Match Telegram/WhatsApp convention: return to chat list after long absence (>= 60s).
const RESUME_THRESHOLD_MS = 60_000;

export function useResumeRedirect(): void {
  // Mobile-only UX convention. On web/Electron, switching tabs is not "background" in the same sense.
  if (!isNative) return;

  const router = useRouter();
  const authStore = useAuthStore();
  const callStore = useCallStore();

  let pausedAt: number | null = null;
  let handle: PluginListenerHandle | null = null;
  let unmounted = false;

  onMounted(async () => {
    const h = await CapApp.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) {
        pausedAt = Date.now();
        return;
      }
      const since = pausedAt;
      pausedAt = null;
      if (since === null) return;
      if (Date.now() - since < RESUME_THRESHOLD_MS) return;
      if (!authStore.isAuthenticated || !authStore.matrixReady) return;
      if (authStore.registrationPending) return;
      if (callStore.isInCall) return;
      const current = router.currentRoute.value.name;
      if (current === "ChatPage") return;
      router.replace({ name: "ChatPage" });
    });
    // If we unmounted while awaiting, immediately clean up — otherwise the listener leaks.
    if (unmounted) {
      void h.remove();
      return;
    }
    handle = h;
  });

  onUnmounted(() => {
    unmounted = true;
    void handle?.remove();
  });
}
