import { onMounted, onUnmounted } from "vue";
import { isAndroid } from "@/shared/lib/platform";

type BackHandler = () => boolean; // return true = handled, false = pass through

const handlers: { id: string; priority: number; handler: BackHandler }[] = [];

/**
 * Register a back handler from any component.
 * Higher priority = called first. Return true from handler to consume the event.
 *
 * Priority guide:
 *   100 — media viewer, full-screen overlays, active calls
 *    95 — quick search
 *    90 — modals, bottom sheets, forward picker
 *    85 — drawers
 *    80 — side panels (info panel, search)
 *    70 — sub-views (settings content, group creation)
 *    60 — chat view (back to sidebar on mobile)
 *    55 — tab fallback (Settings/Contacts → Chats on mobile)
 *    50 — router-level pages (settings, profile)
 *    --   (fallback) App.minimizeApp()
 */
export function useAndroidBackHandler(
  id: string,
  priority: number,
  handler: BackHandler,
) {
  if (!isAndroid) return;

  const entry = { id, priority, handler };

  onMounted(() => {
    const idx = handlers.findIndex((h) => h.id === id);
    if (idx !== -1) handlers.splice(idx, 1);
    handlers.push(entry);
    handlers.sort((a, b) => b.priority - a.priority);
  });

  onUnmounted(() => {
    const idx = handlers.findIndex((h) => h.id === id);
    if (idx !== -1) handlers.splice(idx, 1);
  });
}

/**
 * Initialize the global Capacitor backButton listener.
 * Call once from App.vue onMounted.
 */
export async function initAndroidBackListener() {
  if (!isAndroid) return;

  const { App } = await import("@capacitor/app");

  App.addListener("backButton", () => {
    for (const entry of handlers) {
      if (entry.handler()) return;
    }
    App.minimizeApp();
  });
}
