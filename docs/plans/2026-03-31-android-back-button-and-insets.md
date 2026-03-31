# Android Back Button & Bottom Insets Fix — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix two Android issues: (1) hardware Back button doesn't navigate within the app (closes it instead), (2) bottom UI elements are covered by system navigation bar.

**Architecture:** Create a composable `useAndroidBackHandler` that listens to Capacitor's `backButton` event and dispatches back-navigation based on app state priority stack. Fix `MainActivity.kt` to properly enable edge-to-edge mode via `WindowCompat.setDecorFitsSystemWindows(window, false)` so CSS variable injection actually receives correct inset values.

**Tech Stack:** Vue 3 Composition API, @capacitor/app, Kotlin (Android), CSS custom properties

---

## Task 1: Enable edge-to-edge in MainActivity

**Files:**
- Modify: `android/app/src/main/java/com/forta/chat/MainActivity.kt:24-62`

**Step 1: Add import and enable edge-to-edge**

Add `WindowCompat` import and call `setDecorFitsSystemWindows(window, false)` before the insets listener. This is the critical missing piece — without it, systemBars insets may return `0` on some devices.

```kotlin
package com.forta.chat

import android.os.Bundle
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.BridgeActivity
import com.forta.chat.plugins.tor.TorPlugin
import com.forta.chat.plugins.calls.CallPlugin
import com.forta.chat.plugins.filetransfer.TorFilePlugin
import com.forta.chat.plugins.webrtc.WebRTCPlugin
import com.forta.chat.plugins.updater.UpdaterPlugin
import com.forta.chat.plugins.push.PushDataPlugin
import com.forta.chat.updater.AppUpdater
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class MainActivity : BridgeActivity() {

    private val activityScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(TorPlugin::class.java)
        registerPlugin(CallPlugin::class.java)
        registerPlugin(TorFilePlugin::class.java)
        registerPlugin(WebRTCPlugin::class.java)
        registerPlugin(UpdaterPlugin::class.java)
        registerPlugin(PushDataPlugin::class.java)
        super.onCreate(savedInstanceState)

        // Enable edge-to-edge: content draws behind system bars, insets are non-zero
        WindowCompat.setDecorFitsSystemWindows(window, false)

        // Auto-check for updates (respects 1-hour cache)
        activityScope.launch {
            AppUpdater.checkForUpdateIfNeeded(this@MainActivity, isManual = false)
        }

        // Inject real safe area insets as CSS variables into the WebView
        val rootView = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(rootView) { view, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val density = resources.displayMetrics.density
            val top = (systemBars.top / density).toInt()
            val bottom = (systemBars.bottom / density).toInt()
            val left = (systemBars.left / density).toInt()
            val right = (systemBars.right / density).toInt()

            bridge?.webView?.post {
                bridge?.webView?.evaluateJavascript(
                    """
                    document.documentElement.style.setProperty('--safe-area-inset-top', '${top}px');
                    document.documentElement.style.setProperty('--safe-area-inset-bottom', '${bottom}px');
                    document.documentElement.style.setProperty('--safe-area-inset-left', '${left}px');
                    document.documentElement.style.setProperty('--safe-area-inset-right', '${right}px');
                    """.trimIndent(),
                    null
                )
            }

            ViewCompat.onApplyWindowInsets(view, insets)
        }
    }
}
```

**Step 2: Verify build**

Run: `cd android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

**Step 3: Commit**

```bash
git add android/app/src/main/java/com/forta/chat/MainActivity.kt
git commit -m "fix(android): enable edge-to-edge in MainActivity for correct inset values"
```

---

## Task 2: Create back-navigation composable

**Files:**
- Create: `src/shared/lib/composables/use-android-back-handler.ts`

**Step 1: Create the composable**

This composable implements a priority-based back navigation stack. Overlays register/unregister themselves; the handler dispatches to the highest-priority open overlay, or falls back to app-level navigation.

```typescript
import { ref, onMounted, onUnmounted } from "vue";
import { isAndroid } from "@/shared/lib/platform";

type BackHandler = () => boolean; // return true = handled, false = pass through

const handlers: { id: string; priority: number; handler: BackHandler }[] = [];

/**
 * Register a back handler from any component.
 * Higher priority = called first. Return true from handler to consume the event.
 *
 * Priority guide:
 *   100 — media viewer, full-screen overlays
 *    90 — modals, bottom sheets
 *    80 — drawers, side panels (info panel, search)
 *    70 — sub-views (settings content, group creation)
 *    60 — chat view (back to sidebar on mobile)
 *    10 — root screen (exit app)
 */
export function useAndroidBackHandler(
  id: string,
  priority: number,
  handler: BackHandler,
) {
  if (!isAndroid) return;

  const entry = { id, priority, handler };

  onMounted(() => {
    // Remove any existing handler with same id (safety)
    const idx = handlers.findIndex((h) => h.id === id);
    if (idx !== -1) handlers.splice(idx, 1);
    handlers.push(entry);
    handlers.sort((a, b) => b.priority - a.priority);
  });

  onUnmounted(() => {
    const idx = handlers.findIndex((h) => h.id === id);
    if (idx !== -1) handlers.splice(idx, 1);
  });
}

/**
 * Initialize the global Capacitor backButton listener.
 * Call once from App.vue onMounted.
 */
export async function initAndroidBackListener() {
  if (!isAndroid) return;

  const { App } = await import("@capacitor/app");

  App.addListener("backButton", ({ canGoBack }) => {
    // Walk handlers from highest to lowest priority
    for (const entry of handlers) {
      if (entry.handler()) return; // consumed
    }
    // Nothing handled it — minimize app (don't kill, user can return)
    App.minimizeApp();
  });
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx vue-tsc --noEmit`
Expected: no errors

**Step 3: Commit**

```bash
git add src/shared/lib/composables/use-android-back-handler.ts
git commit -m "feat(android): add useAndroidBackHandler composable for hardware back button"
```

---

## Task 3: Initialize back listener in App.vue

**Files:**
- Modify: `src/app/App.vue`

**Step 1: Import and call init**

Add import at the top of `<script setup>`:

```typescript
import { initAndroidBackListener } from "@/shared/lib/composables/use-android-back-handler";
```

Inside the existing `onMounted`, after the `isNative` block for push events (after line 115), add:

```typescript
// Initialize Android hardware back button handler
initAndroidBackListener();
```

**Step 2: Verify build**

Run: `npm run build`
Expected: BUILD SUCCESSFUL

**Step 3: Commit**

```bash
git add src/app/App.vue
git commit -m "feat(android): initialize back button listener in App.vue"
```

---

## Task 4: Register back handlers in ChatPage (mobile navigation)

**Files:**
- Modify: `src/pages/chat/ChatPage.vue`

This is the critical handler — on mobile, Back should:
1. Close group creation panel → if open
2. Close settings content panel → if open
3. Go from chat back to sidebar → if in chat
4. On sidebar root → minimize app (handled by fallback in composable)

**Step 1: Add back handlers**

Add import:

```typescript
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";
```

After the existing composable calls (after line 14), add:

```typescript
// Android back: close overlays or go back to sidebar
useAndroidBackHandler("chat-group-creation", 70, () => {
  if (!isMobile.value || !showGroupCreation.value) return false;
  showGroupCreation.value = false;
  return true;
});

useAndroidBackHandler("chat-settings-content", 70, () => {
  if (!isMobile.value || !settingsSubView.value) return false;
  closeSettingsContent();
  return true;
});

useAndroidBackHandler("chat-back-to-sidebar", 60, () => {
  if (!isMobile.value || showSidebar.value) return false;
  onBackToSidebar();
  return true;
});
```

**Step 2: Verify build**

Run: `npm run build`
Expected: BUILD SUCCESSFUL

**Step 3: Commit**

```bash
git add src/pages/chat/ChatPage.vue
git commit -m "feat(android): register back handlers for mobile chat navigation"
```

---

## Task 5: Register back handlers in ChatWindow overlays

**Files:**
- Modify: `src/widgets/chat-window/ChatWindow.vue`

ChatWindow has local overlay state: `showForwardPicker`, `showSearch`, `showInfoPanel`, `showDonateModal`. Each should be closeable with Back.

**Step 1: Add back handlers**

Add import:

```typescript
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";
```

After the existing refs (around line 165), add:

```typescript
// Android back: close overlays in ChatWindow
useAndroidBackHandler("chat-forward-picker", 90, () => {
  if (!showForwardPicker.value) return false;
  showForwardPicker.value = false;
  chatStore.exitSelectionMode();
  return true;
});

useAndroidBackHandler("chat-search", 80, () => {
  if (!showSearch.value) return false;
  showSearch.value = false;
  return true;
});

useAndroidBackHandler("chat-info-panel", 80, () => {
  if (!showInfoPanel.value) return false;
  showInfoPanel.value = false;
  return true;
});

useAndroidBackHandler("chat-donate-modal", 90, () => {
  if (!showDonateModal.value) return false;
  showDonateModal.value = false;
  return true;
});
```

**Step 2: Verify build**

Run: `npm run build`
Expected: BUILD SUCCESSFUL

**Step 3: Commit**

```bash
git add src/widgets/chat-window/ChatWindow.vue
git commit -m "feat(android): register back handlers for chat window overlays"
```

---

## Task 6: Register back handlers in shared UI components (Modal, BottomSheet, Drawer)

**Files:**
- Modify: `src/shared/ui/modal/Modal.vue`
- Modify: `src/shared/ui/bottom-sheet/BottomSheet.vue`
- Modify: `src/shared/ui/drawer/ui/Drawer.vue`

These are generic components used across the app. Each should close on Back when visible.

**Step 1: Add handler to Modal.vue**

Add import:

```typescript
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";
```

After the `onKeydown` function, add:

```typescript
// Android back: close modal when shown
useAndroidBackHandler(`modal-${Math.random().toString(36).slice(2, 8)}`, 90, () => {
  if (!props.show) return false;
  emit("close");
  return true;
});
```

**Step 2: Add handler to BottomSheet.vue**

Add the same import and after the drag logic:

```typescript
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";

// Android back: close bottom sheet when shown
useAndroidBackHandler(`bottomsheet-${Math.random().toString(36).slice(2, 8)}`, 90, () => {
  if (!props.show) return false;
  emit("close");
  return true;
});
```

**Step 3: Add handler to Drawer.vue**

Add import and after `onUnmounted(closeDrawer)`:

```typescript
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";

// Android back: close drawer when shown
useAndroidBackHandler(`drawer-${props.id}`, 85, () => {
  if (!isDisplayCurrentDrawer.value) return false;
  closeDrawer();
  return true;
});
```

**Step 4: Verify build**

Run: `npm run build`
Expected: BUILD SUCCESSFUL

**Step 5: Commit**

```bash
git add src/shared/ui/modal/Modal.vue src/shared/ui/bottom-sheet/BottomSheet.vue src/shared/ui/drawer/ui/Drawer.vue
git commit -m "feat(android): register back handlers in Modal, BottomSheet, Drawer"
```

---

## Task 7: Register back handler for MediaViewer

**Files:**
- Modify: `src/features/messaging/ui/MediaViewer.vue`

MediaViewer is a full-screen overlay with highest priority.

**Step 1: Add handler**

Add import:

```typescript
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";
```

After the existing refs, add:

```typescript
// Android back: close media viewer (highest overlay priority)
useAndroidBackHandler("media-viewer", 100, () => {
  if (!props.show) return false;
  emit("close");
  return true;
});
```

**Step 2: Verify build**

Run: `npm run build`
Expected: BUILD SUCCESSFUL

**Step 3: Commit**

```bash
git add src/features/messaging/ui/MediaViewer.vue
git commit -m "feat(android): register back handler for MediaViewer"
```

---

## Task 8: Register back handler for QuickSearchModal

**Files:**
- Modify: `src/app/App.vue`

QuickSearchModal is rendered in App.vue and uses `v-if="showQuickSearch"`. Need to close it on Back.

**Step 1: Add handler**

Add import (already added in Task 3, just extend usage):

```typescript
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";
```

After `const showQuickSearch = ref(false);` (line 132), add:

```typescript
// Android back: close quick search
useAndroidBackHandler("quick-search", 95, () => {
  if (!showQuickSearch.value) return false;
  showQuickSearch.value = false;
  return true;
});
```

**Step 2: Verify build**

Run: `npm run build`
Expected: BUILD SUCCESSFUL

**Step 3: Commit**

```bash
git add src/app/App.vue
git commit -m "feat(android): register back handler for QuickSearchModal"
```

---

## Task 9: Register back handlers for IncomingCallModal and CallWindow

**Files:**
- Modify: `src/features/video-calls/ui/IncomingCallModal.vue`
- Modify: `src/features/video-calls/ui/CallWindow.vue`

These are full-screen overlays that should NOT be closeable with Back (calls shouldn't be accidentally ended). But if they have sub-menus or if IncomingCallModal should block Back, we need to consume the event.

**Step 1: Block back during call overlays**

In `IncomingCallModal.vue`, add:

```typescript
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";

// Block Android back during incoming call (don't accidentally dismiss)
useAndroidBackHandler("incoming-call", 100, () => {
  // Consume the event but don't close — user must use accept/decline buttons
  return !!props.show; // only consume when visible
});
```

In `CallWindow.vue`, add similarly — check how it detects visibility.

**Step 2: Verify build**

Run: `npm run build`
Expected: BUILD SUCCESSFUL

**Step 3: Commit**

```bash
git add src/features/video-calls/ui/IncomingCallModal.vue src/features/video-calls/ui/CallWindow.vue
git commit -m "feat(android): block accidental back press during active calls"
```

---

## Task 10: Register back handler for non-chat pages

**Files:**
- Modify: `src/pages/settings/SettingsPage.vue`
- Modify: `src/pages/profile/ProfilePage.vue`
- Modify: `src/pages/settings/AppearancePage.vue`

These pages use `router.push()` to navigate, so `router.back()` should work. Register handlers.

**Step 1: Add handlers**

For `AppearancePage.vue` (already has router.back()):

```typescript
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";

useAndroidBackHandler("appearance-page", 50, () => {
  router.back();
  return true;
});
```

For `SettingsPage.vue`:

```typescript
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";

useAndroidBackHandler("settings-page", 50, () => {
  router.push({ name: "ChatPage" });
  return true;
});
```

For `ProfilePage.vue`:

```typescript
import { useAndroidBackHandler } from "@/shared/lib/composables/use-android-back-handler";

useAndroidBackHandler("profile-page", 50, () => {
  router.push({ name: "ChatPage" });
  return true;
});
```

**Step 2: Verify build**

Run: `npm run build`
Expected: BUILD SUCCESSFUL

**Step 3: Commit**

```bash
git add src/pages/settings/SettingsPage.vue src/pages/profile/ProfilePage.vue src/pages/settings/AppearancePage.vue
git commit -m "feat(android): register back handlers for settings/profile pages"
```

---

## Task 11: Full verification

**Step 1: Build**

Run: `npm run build`
Expected: BUILD SUCCESSFUL

**Step 2: Lint**

Run: `npm run lint`
Expected: No errors

**Step 3: TypeScript check**

Run: `npx vue-tsc --noEmit`
Expected: No errors

**Step 4: Tests**

Run: `npm run test`
Expected: All pass

**Step 5: Android build**

Run: `cd android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

---

## Summary of changes

| File | Change |
|------|--------|
| `MainActivity.kt` | Add `WindowCompat.setDecorFitsSystemWindows(window, false)` |
| `use-android-back-handler.ts` | New composable: priority-based back handler registry |
| `App.vue` | Init back listener + QuickSearch handler |
| `ChatPage.vue` | Back handlers for group creation, settings panel, chat→sidebar |
| `ChatWindow.vue` | Back handlers for forward picker, search, info panel, donate modal |
| `Modal.vue` | Generic back handler for all modals |
| `BottomSheet.vue` | Generic back handler for all bottom sheets |
| `Drawer.vue` | Generic back handler for drawers |
| `MediaViewer.vue` | Back handler (highest priority) |
| `IncomingCallModal.vue` | Block back during incoming call |
| `CallWindow.vue` | Block back during active call |
| `SettingsPage.vue` | Back → ChatPage |
| `ProfilePage.vue` | Back → ChatPage |
| `AppearancePage.vue` | Back → router.back() |

## Back handler priority stack

```
100  MediaViewer, IncomingCallModal, CallWindow (full-screen overlays)
 95  QuickSearchModal
 90  Modal, BottomSheet, ForwardPicker, DonateModal
 85  Drawer
 80  ChatSearch, ChatInfoPanel
 70  GroupCreation, SettingsContentPanel
 60  Chat → Sidebar (mobile)
 50  Router-level pages (Settings, Profile, Appearance)
 --  (fallback) App.minimizeApp()
```
