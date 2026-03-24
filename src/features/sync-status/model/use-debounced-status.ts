import { ref, watch, onScopeDispose, type Ref } from "vue";
import type { SyncPhase } from "./use-sync-status";

export type DisplayPhase = SyncPhase | "idle";

const SHOW_DELAY: Partial<Record<SyncPhase, number>> = {
  offline: 0,
  error: 0,
  connecting: 1500,
  catching_up: 1500,
};

const MIN_DISPLAY = 600;
const SUCCESS_SHOW = 0;

function isActivePhase(s: string): boolean {
  return s === "offline" || s === "connecting" || s === "catching_up" || s === "error";
}

export function useDebouncedStatus(raw: Ref<SyncPhase>) {
  const visibleStatus = ref<DisplayPhase>("idle");

  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let successTimer: ReturnType<typeof setTimeout> | null = null;
  let shownAt = 0;

  function clearAll() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (successTimer) { clearTimeout(successTimer); successTimer = null; }
  }

  watch(raw, (next) => {
    if (isActivePhase(next)) {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (successTimer) { clearTimeout(successTimer); successTimer = null; }

      const delay = SHOW_DELAY[next] ?? 300;

      if (isActivePhase(visibleStatus.value)) {
        visibleStatus.value = next;
        return;
      }

      if (showTimer) clearTimeout(showTimer);
      showTimer = setTimeout(() => {
        visibleStatus.value = next;
        shownAt = Date.now();
        showTimer = null;
      }, delay);
      return;
    }

    if (next === "syncing" || next === "up_to_date") {
      if (showTimer !== null) {
        clearTimeout(showTimer);
        showTimer = null;
        return;
      }

      if (isActivePhase(visibleStatus.value)) {
        const elapsed = Date.now() - shownAt;
        const remaining = Math.max(0, MIN_DISPLAY - elapsed);

        hideTimer = setTimeout(() => {
          hideTimer = null;
          visibleStatus.value = "up_to_date";

          successTimer = setTimeout(() => {
            visibleStatus.value = "idle";
            successTimer = null;
          }, SUCCESS_SHOW);
        }, remaining);
      }
    }
  });

  onScopeDispose(clearAll);

  return { visibleStatus };
}
