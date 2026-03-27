# Tor Init Graceful Degradation

## Problem
App shows "Failed to start Forta Chat / Tor init timed out after 30000ms" and users cannot enter the app at all. The 30s JS timeout is too aggressive for mobile networks where Tor bootstrap takes 40-90s.

## Solution
Tor init does NOT block app startup. If Tor doesn't start within the timeout, the app loads with direct connections. Tor continues bootstrapping in background and auto-switches when ready.

## Behavior
1. Tor init starts in parallel with boot
2. Wait up to 90s (with 20s stall detection)
3. If OK → app starts with Tor
4. If timeout/stall → app starts WITHOUT Tor, toast shown: "Secure connection unavailable. Enable in Settings."
5. Tor continues in background → when ready, switches automatically

## Files Changed
- `src/app/providers/index.ts` — non-blocking Tor init
- `src/shared/lib/tor/tor-service.ts` — background init, stall detection
- `android/.../TorManager.kt` — pre-checks, tracing
- `android/.../TorPlugin.kt` — clearTorCache method
- `src/app/ui/` — tor failure notification component

## What stays unchanged
- "Clear cache & retry" button behavior
- Boot-status state machine
- Electron Tor flow
