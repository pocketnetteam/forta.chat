import type { NetworkStatsEvent } from "@/entities/tor/lib/network-stats";

type NetworkStatsHandler = (event: NetworkStatsEvent) => void;

export function initNetworkStatsListener(handler: NetworkStatsHandler): () => void {
  if (typeof BroadcastChannel === "undefined") {
    return () => {};
  }

  const swBC = new BroadcastChannel("ServiceWorker");

  swBC.onmessage = ({ data: msg }) => {
    if (msg?.name === "network-stats") {
      handler(msg.data as NetworkStatsEvent);
    }
  };

  return () => {
    swBC.onmessage = null;
    swBC.close();
  };
}
