# Issue (deferred to v2): NSE Olm decryption for E2E rooms

**Parent plan:** [`2026-05-12-ios-apns-push.md`](./2026-05-12-ios-apns-push.md) — Task 4.
**Status:** deferred from Step 7 (Phase 5). Tracking ticket to file once v1 ships.

## Current behaviour (v1, shipped in Step 7)

The Notification Service Extension (`ios/App/NotificationService/NotificationService.swift`) renders push notifications offline using:

- `room_name` / `sender_display_name` from the Sygnal payload, falling back to the App Group name cache (`SharedDataStore`).
- `content_body` from the Sygnal payload **for non-encrypted rooms only**.
- A localized `"New message"` placeholder for any push where `content_body` is missing — which on this homeserver means every E2E room.

User-visible consequence: messages in non-E2E rooms show the actual text in the push banner. Messages in E2E rooms show `<sender_display_name> · <room_name> · "New message"`.

## Goal (v2)

Decrypt `m.room.encrypted` bodies inside the NSE so E2E rooms also display the real message text in the push banner, matching Android's behaviour after `tryDecryptAndReplace` lands.

## Why deferred

Running Matrix E2E decryption in Swift requires one of:

1. **Port the Olm session-keys store + AES-CTR primitives to Swift** so the NSE can decrypt server-pushed ciphertext in-process without a Matrix sync. Implies vendoring `libolm` (or `vodozemac`) into the iOS build and writing a Swift façade over the session key store the main app maintains in IndexedDB.

2. **Share decrypted session keys via the App Group.** The main app would have to periodically write room-key material into a Swift-readable file in `group.com.forta.chat` and the NSE would read from there. Still needs a Swift Olm wrapper to actually decrypt, but avoids reimplementing the key management.

Either path is multi-week work. v1 ships the static rendering Path so the rest of the iOS port can move forward.

## Out of scope for v1

- `m.room.encrypted` → plaintext.
- Read-receipt suppression (don't notify on rooms where the user already read past the event).
- Rich media previews (image attachment in the push body).

## Acceptance criteria for v2 ticket

- [ ] NSE can decrypt `m.room.encrypted` events delivered via Sygnal's `fortaios` pusher within the OS-allotted 30 s window.
- [ ] No regression on memory: NSE stays under the ~24 MB process limit.
- [ ] Session keys remain consistent between main app and NSE across re-login, device key rotation, and app reinstall (the main app's IndexedDB → shared-store sync must not lag the push).
- [ ] Fallback to the `"New message"` placeholder when decryption fails — never deliver garbled ciphertext to the lock screen.

## Files to touch when v2 lands

- `ios/App/NotificationService/NotificationService.swift` — call into the new Olm-Swift wrapper before `renderBody`.
- New target / SPM package — Swift Olm wrapper.
- `src/shared/lib/local-db/` — add a "key snapshot" writer that the main app calls on each `Event.decrypted` and on key rotation, materialising the keys into the App Group container.

## Tracking

File an issue titled exactly:

> **NSE: implement Olm decryption for E2E rooms (iOS v2)**

with the body of this document linked in, when v1 ships. Until then this file is the canonical reference for the deferral decision.
