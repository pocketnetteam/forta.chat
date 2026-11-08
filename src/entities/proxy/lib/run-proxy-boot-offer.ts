/**
 * Boot-time proxy race + optional Local offer (donor satolist directdialog).
 *
 * Wait {@link PROXY_OFFER_DECISION_MS} for remotes. If none answered and Local
 * is ready → confirm dialog. Gateway pings keep a longer timeout and may still
 * win later (dismiss offer / pin remote).
 */

import {
  configurePocketnetNodes,
  setNodeFailoverStickyIndex,
  raceGateways,
  pingLocal,
  PROXY_OFFER_DECISION_MS,
  PROXY_GATEWAY_PING_TIMEOUT_MS,
} from "@/shared/lib/pocketnet";
import { useProxyStore, LOCAL_PROXY_ID } from "../model";

export interface RunProxyBootOfferDeps {
  race?: typeof raceGateways;
  pingLocalFn?: typeof pingLocal;
  /** Decision window before offering Local (default 4s). */
  budgetMs?: number;
  /** Per-gateway ping ceiling (default 10s) — not aborted at budget. */
  gatewayPingTimeoutMs?: number;
  /** Re-check remotes while the dialog is open; if a remote revives, dismiss. */
  watchRemoteRevive?: boolean;
  revivePollMs?: number;
  reviveAttempts?: number;
}

export type ProxyBootOfferOutcome =
  | "skipped"
  | "remote_ok"
  | "offered"
  | "local_dead"
  | "error";

/**
 * Decide whether to offer Local Node Proxy after a gateway race.
 * Pure gate used by {@link runProxyBootOffer} and unit tests.
 */
export function shouldOfferLocal(args: {
  mode: string;
  localAvailable: boolean;
  canOfferThisSession: boolean;
  remoteWinner: string | null;
  localOk: boolean;
}): boolean {
  if (args.mode !== "auto") return false;
  if (!args.localAvailable) return false;
  if (!args.canOfferThisSession) return false;
  if (args.remoteWinner) return false;
  return args.localOk;
}

function pinRemote(
  store: ReturnType<typeof useProxyStore>,
  urls: string[],
  winnerUrl: string,
): void {
  const idx = urls.indexOf(winnerUrl);
  if (idx >= 0) setNodeFailoverStickyIndex(idx);
  configurePocketnetNodes(urls);
  const hostPort = winnerUrl.replace(/^https?:\/\//, "");
  store.preferGateway(hostPort);
  store.setHealth("ok", hostPort);
}

export async function runProxyBootOffer(
  deps: RunProxyBootOfferDeps = {},
): Promise<ProxyBootOfferOutcome> {
  const store = useProxyStore();

  if (store.mode !== "auto") return "skipped";
  if (!store.localAvailable) return "skipped";
  if (!store.canOfferLocalThisSession()) return "skipped";

  const decisionMs = deps.budgetMs ?? PROXY_OFFER_DECISION_MS;
  const gatewayPingTimeoutMs =
    deps.gatewayPingTimeoutMs ?? PROXY_GATEWAY_PING_TIMEOUT_MS;
  const race = deps.race ?? raceGateways;
  const pingLocalFn = deps.pingLocalFn ?? pingLocal;
  const urls = store.gatewayBaseUrls();

  store.setHealth("checking");

  try {
    const [remote, localOk] = await Promise.all([
      race(urls, decisionMs, {
        timeoutMs: gatewayPingTimeoutMs,
        onLateWinner: (url) => {
          if (store.mode !== "auto") return;
          if (store.offerLocalPending) {
            store.dismissLocalOffer();
          }
          pinRemote(store, urls, url);
          console.info("[proxy-boot-offer] late remote_ok", url);
        },
      }),
      pingLocalFn({ timeoutMs: decisionMs }),
    ]);

    if (remote.winner) {
      pinRemote(store, urls, remote.winner);
      console.info(
        "[proxy-boot-offer] remote_ok",
        remote.winner.replace(/^https?:\/\//, ""),
        `decision=${decisionMs}ms`,
      );
      return "remote_ok";
    }

    if (
      !shouldOfferLocal({
        mode: store.mode,
        localAvailable: store.localAvailable,
        canOfferThisSession: store.canOfferLocalThisSession(),
        remoteWinner: remote.winner,
        localOk,
      })
    ) {
      store.setHealth(localOk ? "ok" : "error", localOk ? "local" : "");
      console.info("[proxy-boot-offer] local_dead_or_gated", {
        localOk,
        mode: store.mode,
        localAvailable: store.localAvailable,
      });
      return "local_dead";
    }

    store.showLocalOffer();
    store.setHealth("ok", LOCAL_PROXY_ID);
    console.info("[proxy-boot-offer] offered local", `decision=${decisionMs}ms`);

    if (deps.watchRemoteRevive !== false) {
      void watchReviveWhileOffered(store, race, urls, {
        pollMs: deps.revivePollMs ?? 2_000,
        attempts: deps.reviveAttempts ?? 5,
        pingTimeoutMs: gatewayPingTimeoutMs,
      });
    }

    return "offered";
  } catch (e) {
    console.warn("[proxy-boot-offer] failed:", e);
    store.setHealth("error");
    return "error";
  }
}

async function watchReviveWhileOffered(
  store: ReturnType<typeof useProxyStore>,
  race: typeof raceGateways,
  urls: string[],
  opts: { pollMs: number; attempts: number; pingTimeoutMs: number },
): Promise<void> {
  for (let i = 0; i < opts.attempts; i++) {
    await new Promise((r) => setTimeout(r, opts.pollMs));
    if (!store.offerLocalPending) return;
    try {
      const again = await race(urls, opts.pollMs, {
        timeoutMs: opts.pingTimeoutMs,
      });
      if (again.winner) {
        store.dismissLocalOffer();
        pinRemote(store, urls, again.winner);
        return;
      }
    } catch {
      /* keep offering */
    }
  }
}
