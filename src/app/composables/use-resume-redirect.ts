import { onMounted, onUnmounted } from "vue";
import { useRouter } from "vue-router";
import { App as CapApp, type PluginListenerHandle } from "@capacitor/app";
import { useCallStore } from "@/entities/call";

const RESUME_THRESHOLD_MS = 60_000;

export function useResumeRedirect(): void {
  const router = useRouter();
  const callStore = useCallStore();
  let pausedAt: number | null = null;
  let handle: PluginListenerHandle | null = null;

  onMounted(async () => {
    handle = await CapApp.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) {
        pausedAt = Date.now();
        return;
      }
      const since = pausedAt;
      pausedAt = null;
      if (since === null) return;
      if (Date.now() - since < RESUME_THRESHOLD_MS) return;
      if (callStore.isInCall) return;
      const current = router.currentRoute.value.name;
      if (current === "ChatPage") return;
      router.replace({ name: "ChatPage" });
    });
  });

  onUnmounted(() => {
    void handle?.remove();
  });
}
