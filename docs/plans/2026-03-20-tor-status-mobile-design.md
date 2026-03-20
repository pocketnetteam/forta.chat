# Tor Status Display for Capacitor Mobile App

**Date**: 2026-03-20

## Goal

Show Tor connection status in mobile app settings (like Electron desktop), with toggle on/off and real verification that Tor is actually working.

## Architecture

### 1. TorStore ↔ TorService Bridge

Currently `useTorStore` (Pinia) only works via `electronAPI` IPC. On native Capacitor, `torService` manages the Tor daemon independently. Need to unify so the store works on both platforms:

- On Electron: keep existing `electronAPI` path
- On Native: store calls `torService` methods, subscribes to `torService.state`/`torService.progress` reactivity

### 2. Settings UI

Remove `v-if="isElectron"` guard from Tor section in `SettingsPage.vue`. Show on both Electron and native:

- Shield icon + "Tor Proxy" label + Toggle on/off
- Status indicator (colored dot + text): Connected / Connecting / Error / Off
- Bootstrap progress during connection (yellow text)
- "Verify" button — real check that Tor routes traffic
- Verification result: shows Tor exit IP or "Not using Tor"
- Error message on failure

### 3. Tor Verification (two-step)

1. **Primary**: `GET https://check.torproject.org/api/ip` through Tor HTTP proxy (`http://127.0.0.1:8181`). Returns `{"IsTor": true, "IP": "x.x.x.x"}`. If `IsTor` is true → confirmed.
2. **Fallback**: `GET https://api.ipify.org?format=json` through Tor proxy AND directly. Compare IPs — if different, Tor is working.

### 4. Toggle with Warning

- **Enabling Tor**: starts immediately, no confirmation needed
- **Disabling Tor**: confirmation dialog — "Disabling Tor will expose your real IP address. Your traffic will no longer be anonymous. Continue?"
- Toggle triggers `torService.init('always')` or `torService.stop()`

## Files to Modify

| File | Changes |
|------|---------|
| `src/entities/tor/model/stores.ts` | Add native support via torService, verify action |
| `src/shared/lib/tor/tor-service.ts` | Add `verify()` method, `stop()`/`start()` toggle support |
| `src/pages/settings/SettingsPage.vue` | Remove `v-if="isElectron"`, add verify button, warning dialog |
| `src/shared/lib/i18n/locales/en.ts` | i18n keys for Tor verification UI |

## Status Mapping

| TorService state | TorStore status | UI |
|------------------|-----------------|----|
| `RUNNING` (bootstrap) | `running` | Yellow pulsing dot, "Connecting..." |
| `RUNNING` (ready) | `started` | Green dot, "Connected" |
| `STOPPED` | `stopped` | Gray dot, "Off" |
| `FAILED` | `failed` | Red dot, "Error" |
