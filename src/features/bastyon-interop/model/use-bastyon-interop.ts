import { computed, ref } from "vue";
import { useAuthStore } from "@/entities/auth";
import { isNative, isAndroid } from "@/shared/lib/platform";
import { useLocalStorage } from "@/shared/lib/browser";
import { shouldShowBastyonWarning } from "@/shared/lib/interop";

/**
 * Dual-install warning state (WEE-35 Task 5). Surfaces a dismissible banner
 * when the signed-in account looks Bastyon-registered (see authStore
 * `likelyBastyonUser`) and both apps can coexist (native Android).
 */
export function useBastyonInterop() {
  const authStore = useAuthStore();

  const { setLSValue, value: storedDismissed } = useLocalStorage<boolean>(
    "bastyon_warning_dismissed",
    false
  );
  const dismissed = ref<boolean>(storedDismissed);

  const isNativeAndroid = isNative && isAndroid;

  const showWarning = computed(() =>
    shouldShowBastyonWarning({
      likelyBastyonUser: authStore.likelyBastyonUser,
      dismissed: dismissed.value,
      isNativeAndroid,
    })
  );

  function dismiss(): void {
    dismissed.value = true;
    setLSValue(true);
  }

  return { showWarning, dismiss };
}
