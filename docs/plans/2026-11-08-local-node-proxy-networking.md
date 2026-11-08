# Local Node Proxy + Networking proxy switcher

**Date:** 2026-11-08  
**Status:** implemented (unit-covered; device QA in `docs/manual-verification.md`)

## Goal

1. Client-side path to Pocketnet blockchain nodes (port of Bastyon Local Node Proxy).
2. Compact proxy picker in **Settings → Networking** above Tor (Auto / gateways / Local Node Proxy).

## Code map

| Area | Path |
|------|------|
| Proxy store | `src/entities/proxy/` |
| UI | `src/features/settings/ui/ProxySettingsSection.vue` (mounted from `TorSettingsSection.vue`) |
| Local node core | `src/shared/lib/pocketnet/local-node/` |
| RPC wiring | `src/shared/lib/pocketnet/node-rpc-client.ts` (`setPocketnetRpcRouter`) |
| App wire | `src/app/providers/initializers/app-initializer.ts` |

## Behaviour

- **Auto** — gateway failover; if all remotes fail and Local is available → Local Node Proxy.
- **Gateway** — pin one of `listofproxies` (`N.pocketnet.app:8899`).
- **Local** — allowlisted `/public`/`/post` RPC via seeds + discovery; demand-driven `ensureActive`.
- Registration / captcha stay on remote Proxy16 (SDK); `gatewaysOnly` forces gateway path for `callPocketnetRpc`.
- Local disabled on production web hostnames (CORS); enabled on Capacitor / Electron / localhost.
- **Browser localhost:** requests rewrite through CORS relay `127.0.0.1:18081` ([`scripts/local-node-cors-relay.mjs`](../../scripts/local-node-cors-relay.mjs)). Run `npm run local-node-cors` or `npm run dev:local-node` (Vite + relay). Native CapacitorHttp bypasses the relay.
- **SDK bridge:** [`sdk-rpc-bridge.ts`](../../src/shared/lib/pocketnet/sdk-rpc-bridge.ts) wraps `Api.rpc` → `callPocketnetRpc` (Local / sticky gateways). `Proxy16.fetch` (`ping`, `nodes/*`, peertube list) stays on remotes.

## Source

Bastyon: `C:\inetpub\wwwroot\pocketnet\js\lib\client\localnode\` + `docs/local-node-proxy/`.

## Boot offer dialog (donor `directdialog`)

- Race: [`src/shared/lib/pocketnet/proxy-health-race.ts`](../../src/shared/lib/pocketnet/proxy-health-race.ts) — **4 s decision** to offer Local if remotes silent; gateway ping timeout **10 s** (not aborted at 4 s); late remote dismisses dialog / pins gateway.
- Flow: [`src/entities/proxy/lib/run-proxy-boot-offer.ts`](../../src/entities/proxy/lib/run-proxy-boot-offer.ts) — Auto only; once per session.
- UI: [`ProxyLocalOfferDialog.vue`](../../src/features/settings/ui/ProxyLocalOfferDialog.vue) in `App.vue`.
- Kick: `whenChatsInteractive(5s)` in `src/app/providers/index.ts`.
- Copy mirrors Bastyon `pdirectdialog`.
