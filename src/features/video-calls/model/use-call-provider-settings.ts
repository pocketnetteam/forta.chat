import { ref, type Ref } from "vue";
import { useLocalStorage } from "@/shared/lib/browser";

/**
 * Sub-settings for external call providers (WEE-57). Device-local (no
 * server/account_data sync), like the providers themselves.
 *
 * `autoOpenAfterSend` — when the caller starts an external call, immediately
 * open the meeting link in their browser (they're the host). When off, the
 * link is only sent to the chat and the caller joins by tapping the card.
 * Default ON: the common case is "call now, join now".
 *
 * A module-level singleton ref keeps the flag in sync across consumers
 * (settings UI, send path) within a tab.
 */

const LS_KEY = "call_link_auto_open";

const { setLSValue, value: lsInitial } = useLocalStorage<boolean>(LS_KEY);
const autoOpenAfterSend: Ref<boolean> = ref(lsInitial ?? true);

export function useCallProviderSettings(): {
  autoOpenAfterSend: Ref<boolean>;
  setAutoOpenAfterSend: (value: boolean) => void;
} {
  const setAutoOpenAfterSend = (value: boolean): void => {
    autoOpenAfterSend.value = value;
    setLSValue(value);
  };

  return { autoOpenAfterSend, setAutoOpenAfterSend };
}
