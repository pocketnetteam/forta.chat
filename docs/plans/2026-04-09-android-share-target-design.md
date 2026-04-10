# Android Share Target — Design

**Date:** 2026-04-09
**Status:** Approved

## Problem

Forta Chat does not appear in Android's Share Sheet. Users cannot share text, links, images, or files from other apps (Gallery, Browser, etc.) into Forta Chat.

## Solution

Make Forta Chat an Android Share Target by:
1. Declaring intent-filters in AndroidManifest.xml
2. Using `@capgo/capacitor-share-target` plugin to receive shared data
3. Reusing the existing Forward UX (ForwardPicker → chat selection → preview bar → send)

## Architecture

```
Android Share Sheet → intent-filter in AndroidManifest.xml
    → @capgo/capacitor-share-target (listener)
        → shareHandlerService (new service in shared/lib/)
            → save to localStorage (if not authenticated)
            → or immediately: chatStore.initExternalShare(data)
                → router.push ChatPage
                → forwardPickerRequested → ForwardPicker opens
                → user picks chat → content in input → send
```

## Changes

### 1. AndroidManifest.xml — Intent Filters

Add inside the main `<activity>`:

```xml
<intent-filter>
    <action android:name="android.intent.action.SEND" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:mimeType="text/plain" />
    <data android:mimeType="image/*" />
    <data android:mimeType="video/*" />
    <data android:mimeType="application/*" />
</intent-filter>
<intent-filter>
    <action android:name="android.intent.action.SEND_MULTIPLE" />
    <category android:name="android.intent.category.DEFAULT" />
    <data android:mimeType="image/*" />
    <data android:mimeType="*/*" />
</intent-filter>
```

### 2. chatStore — `initExternalShare(data)` method

New method next to `initForward`:
- Creates a `ForwardingMessage` from external share data (synthetic id/roomId)
- Sets `forwardPickerRequested = true`
- Handles text, URLs, images, and files

### 3. `src/shared/lib/share-target.ts` — Handler Service

- Subscribes to `@capgo/capacitor-share-target` events
- If authenticated + Matrix ready → calls `initExternalShare` + routes to ChatPage
- If not ready → saves to localStorage (`bastyon-chat-share-data`) for deferred processing

### 4. App.vue — Initialization

- Initialize share target listener on mount (native only)
- Add `processExternalShare()` following the existing pattern of `processReferral` / `processJoinRoom`
- Watch `authStore.matrixReady` to process deferred shares

### 5. Types — `isExternalShare` flag

Extend `ForwardingMessage` with `isExternalShare?: boolean` to distinguish external shares from internal forwards.

## What Does NOT Change

- **ForwardPicker** — reused as-is
- **MessageInput** — already shows forward preview bar
- **Send logic** — existing forward/send pipeline handles it

## Decisions

- **Deferred share on cold start**: Save to localStorage, process after auth (matches existing `processReferral` / `processJoinRoom` pattern)
- **ForwardPicker location**: Reuse from ChatWindow (route to ChatPage on share), no new global overlay
- **Plugin**: `@capgo/capacitor-share-target` — Capacitor 8 support, listener API, actively maintained
