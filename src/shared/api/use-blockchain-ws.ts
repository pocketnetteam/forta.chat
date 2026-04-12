import { ref, onUnmounted } from "vue";
import { blockchainWs } from "./blockchain-ws";

/**
 * Vue composable that provides reactive access to the BlockchainWsService singleton.
 * Auto-cleans up subscriptions on component unmount.
 */
export function useBlockchainWs() {
  const isConnected = ref(blockchainWs.isConnected);
  const cleanups: Array<() => void> = [];

  const statusUnsub = blockchainWs.on("registered", () => {
    isConnected.value = blockchainWs.isConnected;
  });
  cleanups.push(statusUnsub);

  const msgUnsub = blockchainWs.on("message", () => {
    if (isConnected.value !== blockchainWs.isConnected) {
      isConnected.value = blockchainWs.isConnected;
    }
  });
  cleanups.push(msgUnsub);

  const onBlock = (handler: (data: any) => void) => {
    const unsub = blockchainWs.on("block", handler);
    cleanups.push(unsub);
    return unsub;
  };

  const onTransaction = (handler: (data: any) => void) => {
    const unsub = blockchainWs.on("transaction", handler);
    cleanups.push(unsub);
    return unsub;
  };

  const onSocialEvent = (mesType: string, handler: (data: any) => void) => {
    const unsub = blockchainWs.on(`social:${mesType}`, handler);
    cleanups.push(unsub);
    return unsub;
  };

  onUnmounted(() => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  });

  return {
    isConnected,
    onBlock,
    onTransaction,
    onSocialEvent,
  };
}
