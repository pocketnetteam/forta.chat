# Sygnal pusher config request — iOS

> **Intended reader:** the homeserver / Sygnal admin team that runs `matrix.pocketnet.app` (the same team that already configured `app_id: fortaandroid` for Android FCM push).
>
> **Goal:** add two new push endpoints for the iOS app — one regular APNs pusher (for messages, reactions, mentions) and one VoIP/PushKit pusher (for `m.call.invite` only). Both terminate at the same Sygnal `notify` URL; Sygnal fans out to APNs.

---

## Request summary

| Field | `fortaios` | `fortaios.voip` |
|---|---|---|
| **`app_id`** | `fortaios` | `fortaios.voip` |
| **`kind`** | `http` | `http` |
| **Sygnal `notify` URL** | `https://matrix.pocketnet.app/_matrix/push/v1/notify` | `https://matrix.pocketnet.app/_matrix/push/v1/notify` |
| **APNs delivery class** | Standard alert (`apns-push-type: alert`) | VoIP (`apns-push-type: voip`) |
| **APNs topic** | `com.forta.chat` | `com.forta.chat.voip` |
| **`format`** | `event_id_only` | `event_id_only` |
| **Trigger filter** | All non-`m.call.invite` events that the user's push rules match | **Only** `m.call.invite` (i.e. `event.type == "m.call.invite"`) — never anything else, per Apple's PushKit policy. |
| **Required APNs payload flags** | `mutable-content: 1` (so our Notification Service Extension fires) | None of the alert fields; the payload is data-only |
| **Custom payload data** | See "Standard payload" below | See "VoIP payload" below |
| **Pusher cleanup** | Same as Android — Sygnal expects the device-token rotation behaviour the iOS app implements (re-register with a new `pushkey` when the device's APNs/FCM token changes) | Same |

---

## Why two pushers (and not one)

Apple has two completely separate push pipelines on iOS:

1. **APNs (regular)** — for visible notifications. Goes through `UNUserNotificationCenter`, can be muted / grouped / silenced by the user. FCM token used as `pushkey`. App receives it via `@capacitor/push-notifications` + Notification Service Extension.

2. **PushKit / VoIP** — for telephony. Wakes the app even from a force-quit, but Apple **mandates** that within ~50 ms of receiving the push the app reports a CallKit `CXIncomingCall` (or the OS will permanently ban the bundle from receiving VoIP pushes). Token is a separate `PKPushCredentials.token` — *not* the FCM token. App receives it via our custom `IOSVoIPPush` plugin (Plan 5 Task 3).

Mixing both kinds onto a single `app_id` would force Sygnal to send VoIP-class pushes for non-call events (which Apple penalises) **or** alert-class pushes for `m.call.invite` (which doesn't wake a force-quit app, breaking the call ringer). The clean split is one pusher per pipeline.

This matches Element iOS's setup: two pushers, one regular, one `.voip`, both with `kind: http`, both terminating at Sygnal.

---

## Standard payload (`fortaios`)

Sygnal generates this from the matched Matrix event. The iOS Notification Service Extension reads it. Required fields per Plan 3 (`2026-05-12-ios-apns-push.md`) NSE implementation:

```json
{
  "aps": {
    "alert": {
      "loc-key": "<encrypted-or-passthrough-preview>"
    },
    "mutable-content": 1,
    "sound": "default",
    "badge": 1
  },
  "room_id": "!abcd:matrix.pocketnet.app",
  "event_id": "$xyz",
  "sender": "@alice:matrix.pocketnet.app",
  "sender_display_name": "Alice",
  "room_name": "Project Sync",
  "msg_type": "m.room.message | m.reaction | m.call.hangup | m.call.reject | m.call.select_answer",
  "content_msgtype": "m.text | m.image | m.video | m.audio | m.file",
  "content_body": "<plaintext-if-non-E2E-room>"
}
```

Sygnal fields that we depend on:

- **`mutable-content: 1`** — Apple-required to invoke the Notification Service Extension; without it our NSE never runs and notifications stay generic.
- **`msg_type`** is a Sygnal-side `event.type` echo. We use it in NSE to suppress `m.call.hangup` / `m.call.reject` / `m.call.select_answer` notifications and remove the prior `m.call.invite` notification in the tray. If Sygnal already strips these event types from the iOS pusher path (some configs do), great — let us know and we'll skip the cancel-path branch in NSE. Otherwise please pass them through with the `msg_type` field set as above.
- **`sender_display_name`, `room_name`** — used by NSE to render notifications offline (without hitting `/sync`). Optional but improve UX significantly. Same as the Android push payload pattern.
- **`content_body`** — for non-E2E rooms only. For E2E rooms the NSE shows a `"New message"` placeholder in v1 (decryption-in-NSE deferred to v2).

If Sygnal's current iOS payload schema differs from the above, tell us which field names it actually emits and we'll adjust the NSE keys instead of changing Sygnal.

---

## VoIP payload (`fortaios.voip`)

Triggered **only** when `event.type == "m.call.invite"`. No `aps.alert`, no badge, no sound — the OS hands the payload straight to our app for in-process CallKit handling.

```json
{
  "room_id": "!abcd:matrix.pocketnet.app",
  "event_id": "$invite-event",
  "call_id": "<m.call.invite content.call_id>",
  "sender": "@alice:matrix.pocketnet.app",
  "sender_display_name": "Alice",
  "room_name": "Alice (1:1)",
  "msg_type": "m.call.invite.voice | m.call.invite.video"
}
```

Notes:

- **`call_id`** must equal the Matrix `m.call.invite` content's `call_id` field. Our `IOSVoIPPush` plugin uses it as the CallKit `CXProvider` UUID seed.
- **`msg_type`** — we use the suffix to determine `hasVideo`. If Sygnal can detect video via the `m.call.invite` content's `offer.sdp` containing `m=video`, that's even better; otherwise pass `m.call.invite.voice`/`m.call.invite.video` based on whatever heuristic is convenient (it's a UX hint only — voice calls show "Voice" in CallKit, video shows "Video").
- The iOS app registers a **second** Matrix pusher with `pushkey = <PKPushRegistry voIP token>` against `app_id: fortaios.voip` (Plan 5 Task 3). Sygnal must accept this pusher and use the supplied `pushkey` as the APNs device token for VoIP-class pushes (with the `.voip` topic suffix and `apns-push-type: voip` header).
- **Critical Apple constraint:** if Sygnal sends a VoIP push for any event other than `m.call.invite` (e.g. accidentally for `m.call.hangup` or for a regular text message), Apple may permanently disable VoIP pushes for our bundle. The pusher trigger on the Sygnal side must be strictly limited to `event.type == "m.call.invite"`.

---

## APNs credentials

Sygnal needs a way to talk to APNs on our behalf. The iOS team has provisioned a **token-based APNs auth key (`.p8`)** in Apple Developer:

- Team ID: supplied separately (10-char identifier).
- Key ID: 10-char identifier of the `.p8` key (e.g. `AB12CD34EF`).
- Bundle ID: `com.forta.chat`.

If your Sygnal config takes APNs creds via:

- **The `.p8` key directly** — we will share via 1Password (vault "Forta", item `Forta iOS APNs Key`). Give us the 1Password user(s) to grant access to.
- **Firebase passthrough** — *no APNs creds needed on Sygnal side*; Sygnal uses an FCM HTTP v1 server key and Firebase forwards to APNs. This is what the Android pusher already does (`fortaandroid` is `kind: http` to Sygnal which calls FCM, FCM calls GCM/APNs). Recommended path: same model on iOS — Sygnal just uses the Firebase iOS app's FCM key (already set up by the iOS team in the existing Firebase project, see Step 1 Section E in `STEP-1-CHECKLIST.md`).

For VoIP pushes Firebase **does not** support PushKit — VoIP must hit APNs directly with the `.p8` and the `.voip` topic. So:

- `fortaios` pusher → Sygnal → FCM → APNs (alert-class). Reuse Android plumbing.
- `fortaios.voip` pusher → Sygnal → APNs **directly** with `.p8` (VoIP-class). Needs the `.p8` accessible to Sygnal.

If Sygnal does not currently have direct APNs support (only FCM), let us know — we will provide the `.p8` and you will enable Sygnal's `pushgateway.apns_v3` provider (or equivalent). This is a one-time Sygnal config change.

---

## Email/Slack body (copy-paste; substitute `<your-name>` and the contact handle)

> Hi <homeserver-admin>,
>
> The iOS port of Forta Chat needs two Sygnal pushers added to `matrix.pocketnet.app`:
>
> 1. `app_id: fortaios` — regular APNs (alert-class). Triggers on the same Matrix events as `fortaandroid` *minus* `m.call.invite`. APNs payload should set `mutable-content: 1` and include the standard custom keys: `room_id`, `event_id`, `sender`, `sender_display_name`, `room_name`, `msg_type`, `content_msgtype`, `content_body`. Sygnal `notify` URL: `https://matrix.pocketnet.app/_matrix/push/v1/notify`.
>
> 2. `app_id: fortaios.voip` — VoIP/PushKit. Triggers **only** on `event.type == "m.call.invite"`. APNs `apns-push-type: voip`, topic `com.forta.chat.voip`, payload contains `room_id`, `event_id`, `call_id`, `sender`, `sender_display_name`, `room_name`, `msg_type` (with `.voice`/`.video` suffix). Strict trigger filter is critical — Apple will ban the bundle if VoIP pushes go out for non-call events.
>
> Both bundles share the same Apple Team ID + bundle id `com.forta.chat`. APNs auth credentials:
>
>   • For `fortaios`: reuse FCM (Firebase iOS app is set up under our existing Firebase project, same plumbing as `fortaandroid`).
>   • For `fortaios.voip`: needs the `.p8` directly because Firebase doesn't relay PushKit. We can share the `.p8` via 1Password — please reply with the 1Password account(s) to grant access.
>
> Full payload schema, rationale for why two pushers, and Apple constraints are documented in `docs/plans/ios/SYGNAL-CONFIG-REQUEST.md` in the Forta Chat repo.
>
> Verification once deployed: I'll log in on iOS and confirm `getPushers()` returns both `fortaios` and `fortaios.voip`. Test push from another device to confirm both delivery paths fire.
>
> Thanks,
> <your-name>

---

## Verification (after deployment)

After Sygnal rolls out the config and after the iOS app's Plan 3 + Plan 5 push code is shipped:

- [ ] Log in on a real iOS device. Open the Vue dev console (Safari → Inspect device).
- [ ] Run:

  ```js
  const c = window.matrixServiceInstance.client; // or wherever the SDK client is exposed
  const pushers = await c.getPushers();
  console.table(pushers.pushers);
  ```

- [ ] Expected: two rows, one with `app_id: 'fortaios'` and one with `app_id: 'fortaios.voip'`. Both with `kind: 'http'`, both with `data.url: 'https://matrix.pocketnet.app/_matrix/push/v1/notify'`.
- [ ] Send a text message from another device → notification arrives on iOS within ~5 seconds.
- [ ] Place a voice call from another device → CallKit ringer appears on the iOS device's lock screen within ~3 seconds (the harder constraint).

If `getPushers()` shows only `fortaios` and not `fortaios.voip`: the iOS app's `IOSVoIPPush` registration silently failed or Sygnal rejected the VoIP pusher. Check device console for `[IOSVoIPPush]` logs and Sygnal logs for the rejection reason.

---

## Out of scope for this request

- Sygnal-side filtering by user push rules — already handled by Sygnal's standard `event_id_only` flow; no iOS-specific behaviour.
- Per-device dedup (one user, two iOS devices, two pushers each) — also standard; Matrix's pusher routing already keys by `(app_id, pushkey)`.
- Changes to the Android pusher (`fortaandroid`) — explicitly do **not** touch it.
- Ringtone / vibration patterns — handled client-side via CallKit and `UNNotificationSound`.
