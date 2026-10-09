import { useCallStore } from "@/entities/call";
import { isNative } from "@/shared/lib/platform";

const CHANNEL = "bastyon_call_lock";
const TAB_ID = crypto.randomUUID();

/** Time to wait for another tab's response before assuming no active call (avoids race with slow tabs). */
const TAB_CHECK_TIMEOUT_MS = 1000;

let bc: BroadcastChannel | null = null;

export function initCallTabLock() {
  // One WebView, no other tabs: the check would only hold every dial and
  // every incoming call for the full timeout, which widened the window where
  // a dial and an invite could both claim the empty call slot.
  if (isNative) return;
  bc = new BroadcastChannel(CHANNEL);

  bc.onmessage = (e) => {
    if (e.data.type === "call-active-check") {
      const callStore = useCallStore();
      if (callStore.isInCall) {
        bc?.postMessage({ type: "call-active-response", tabId: TAB_ID });
      }
    }
  };
}

/** Check if another tab already has an active call. Resolves after TAB_CHECK_TIMEOUT_MS if no response. */
export function checkOtherTabHasCall(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!bc) {
      resolve(false);
      return;
    }

    let responded = false;
    const handler = (e: MessageEvent) => {
      if (e.data.type === "call-active-response" && e.data.tabId !== TAB_ID) {
        responded = true;
        bc?.removeEventListener("message", handler);
        resolve(true);
      }
    };
    bc.addEventListener("message", handler);
    bc.postMessage({ type: "call-active-check" });

    setTimeout(() => {
      if (!responded) {
        bc?.removeEventListener("message", handler);
        resolve(false);
      }
    }, TAB_CHECK_TIMEOUT_MS);
  });
}

export function destroyCallTabLock() {
  bc?.close();
  bc = null;
}
