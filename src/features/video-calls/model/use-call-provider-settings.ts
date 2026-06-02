import { ref, type Ref } from "vue";
import { useLocalStorage } from "@/shared/lib/browser";

/**
 * "Use external call providers instead of native Forta calls" toggle (WEE-57).
 *
 * Device-local, like the providers themselves — there is intentionally no
 * server/account_data sync (privacy). A module-level singleton ref keeps the
 * flag in sync across every consumer (settings UI, call button) within a tab.
 */

const LS_KEY = "use_external_call_providers";

const { setLSValue, value: lsInitial } = useLocalStorage<boolean>(LS_KEY);
const useExternalProviders: Ref<boolean> = ref(lsInitial ?? false);

export function useCallProviderSettings(): {
  useExternalProviders: Ref<boolean>;
  setUseExternalProviders: (value: boolean) => void;
} {
  const setUseExternalProviders = (value: boolean): void => {
    useExternalProviders.value = value;
    setLSValue(value);
  };

  return { useExternalProviders, setUseExternalProviders };
}
