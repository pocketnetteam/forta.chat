# Android Safe Area / WindowInsets Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all screens where UI elements overlap system bars (status bar, navigation bar, gesture area, notch) on Android devices.

**Architecture:** Two layers of fixes: (1) Native Android Activities (CallActivity, IncomingCallActivity) — replace hardcoded dp padding with real WindowInsets via a shared helper. (2) Web/Vue layer — add existing safe-area CSS utility classes to fullscreen overlays that currently lack them; fix broken `pb-safe` class in BottomSheet.

**Tech Stack:** Kotlin (Android native), Vue 3 + Tailwind CSS (web layer), Capacitor (bridge)

---

### Task 1: Add `pb-safe` utility class to main.css

**Files:**
- Modify: `src/app/styles/main.css:6-27`

**Step 1: Add the missing `pb-safe` class**

BottomSheet.vue uses `pb-safe` but this class is never defined. Add it inside the existing `@layer utilities` block:

```css
@layer utilities {
  /* ... existing safe-top, safe-bottom, safe-y, safe-all ... */

  /* Bottom-only padding for safe area (no keyboard) — for bottom sheets */
  .pb-safe {
    padding-bottom: var(--safe-area-inset-bottom, 0px);
  }
}
```

Insert after line 26 (before the closing `}` of `@layer utilities`), so the full block becomes:

```css
@layer utilities {
  .safe-top {
    padding-top: var(--safe-area-inset-top, 0px);
  }
  .safe-bottom {
    padding-bottom: max(var(--keyboardheight, 0px), var(--safe-area-inset-bottom, 0px));
  }
  .safe-y {
    padding-top: var(--safe-area-inset-top, 0px);
    padding-bottom: max(var(--keyboardheight, 0px), var(--safe-area-inset-bottom, 0px));
  }
  .safe-all {
    padding-top: var(--safe-area-inset-top, 0px);
    padding-right: var(--safe-area-inset-right, 0px);
    padding-bottom: max(var(--keyboardheight, 0px), var(--safe-area-inset-bottom, 0px));
    padding-left: var(--safe-area-inset-left, 0px);
  }
  .pb-safe {
    padding-bottom: var(--safe-area-inset-bottom, 0px);
  }
}
```

**Step 2: Verify build**

Run: `npm run build`
Expected: SUCCESS — no errors.

**Step 3: Commit**

```bash
git add src/app/styles/main.css
git commit -m "fix: add missing pb-safe CSS utility class for BottomSheet safe area"
```

---

### Task 2: Fix MediaViewer — add safe-area to fullscreen photo viewer

**Files:**
- Modify: `src/features/messaging/ui/MediaViewer.vue:124`

**Context:** MediaViewer is a fullscreen overlay (`fixed inset-0 z-50`) teleported to `<body>`. The close button (✕) at the top is only 48px from the top edge — on devices with notch/status bar, it gets hidden under the system bar. The caption at the bottom can overlap the gesture bar.

**Step 1: Add `safe-all` class to the root container**

In `MediaViewer.vue`, line 124, change:

```html
class="fixed inset-0 z-50 flex flex-col bg-black"
```

to:

```html
class="fixed inset-0 z-50 flex flex-col bg-black safe-all"
```

**Step 2: Verify build**

Run: `npm run build`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/features/messaging/ui/MediaViewer.vue
git commit -m "fix: add safe-area padding to MediaViewer preventing close button overlap on notch devices"
```

---

### Task 3: Fix CallWindow — add safe-area to web call UI

**Files:**
- Modify: `src/features/video-calls/ui/CallWindow.vue:413,658`

**Context:** CallWindow is a fullscreen overlay (`fixed inset-0 z-50`) with:
- A header bar (`absolute top-0`) containing minimize button at `left-4 top-4` — overlaps status bar
- A controls bar (`absolute bottom-0`) with `pb-4`/`pb-6` — overlaps gesture bar
- Spotlight layout uses hardcoded `pt-12 pb-20` / `pt-14 pb-20` — doesn't account for insets

**Step 1: Add safe-top to the header**

In `CallWindow.vue`, line ~413, change the call-header div:

```html
class="call-header absolute left-0 right-0 top-0 z-20 flex items-center justify-center"
:class="isMobile ? 'px-3 py-3' : 'px-6 py-4'"
```

to:

```html
class="call-header absolute left-0 right-0 top-0 z-20 flex items-center justify-center safe-top"
:class="isMobile ? 'px-3 py-3' : 'px-6 py-4'"
```

**Step 2: Add safe-bottom to the controls bar**

In `CallWindow.vue`, line ~658, change the controls bar div:

```html
class="call-controls-bar absolute bottom-0 left-0 right-0 z-20 flex justify-center"
:class="isMobile ? 'pb-4 pt-8' : 'pb-6 pt-10'"
```

to:

```html
class="call-controls-bar absolute bottom-0 left-0 right-0 z-20 flex justify-center pb-safe"
:class="isMobile ? 'pt-8' : 'pt-10'"
```

Note: We replace the static `pb-4`/`pb-6` with `pb-safe` which will apply the actual navigation bar inset. On devices without nav bar padding this effectively becomes 0, but the gradient background (`call-controls-bar` CSS) still provides visual spacing via `pt-8`/`pt-10`.

**Step 3: Fix minimize button position to account for safe-top**

In `CallWindow.vue`, line ~418, change:

```html
class="minimize-btn absolute left-4 top-4 z-30"
```

to:

```html
class="minimize-btn absolute left-4 z-30"
style="top: calc(var(--safe-area-inset-top, 0px) + 16px)"
```

**Step 4: Fix screen-sharing badge position similarly**

In `CallWindow.vue`, line ~453, change:

```html
class="absolute right-4 top-4 flex items-center gap-1.5 rounded-full bg-green-500/90 px-3 py-1 text-xs font-medium text-white shadow-lg"
```

to:

```html
class="absolute right-4 flex items-center gap-1.5 rounded-full bg-green-500/90 px-3 py-1 text-xs font-medium text-white shadow-lg"
style="top: calc(var(--safe-area-inset-top, 0px) + 16px)"
```

**Step 5: Verify build**

Run: `npm run build`
Expected: SUCCESS

**Step 6: Commit**

```bash
git add src/features/video-calls/ui/CallWindow.vue
git commit -m "fix: add safe-area insets to CallWindow header and controls for Android edge-to-edge"
```

---

### Task 4: Fix IncomingCallModal — add safe-area to web incoming call overlay

**Files:**
- Modify: `src/features/video-calls/ui/IncomingCallModal.vue:59`

**Context:** IncomingCallModal is `fixed inset-0 z-50` with centered content. Content is centered via flexbox so it usually avoids system bars, but on small screens the accept/reject buttons (with `gap-8`) could overlap gesture zone.

**Step 1: Add `safe-all` to overlay**

In `IncomingCallModal.vue`, line 59, change:

```html
class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
```

to:

```html
class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm safe-all"
```

**Step 2: Verify build**

Run: `npm run build`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/features/video-calls/ui/IncomingCallModal.vue
git commit -m "fix: add safe-area padding to IncomingCallModal for edge-to-edge Android devices"
```

---

### Task 5: Fix Drawer — add safe-top to prevent notch overlap

**Files:**
- Modify: `src/shared/ui/drawer/ui/Drawer.vue:45`

**Context:** Drawer is a slide-in panel (`h-screen w-[320px]`) teleported to body. Content at the top can be hidden behind the notch/status bar.

**Step 1: Add `safe-y` to drawer content container**

In `Drawer.vue`, line 45, change:

```html
class="h-screen w-[320px] bg-background-total-theme"
```

to:

```html
class="h-screen w-[320px] bg-background-total-theme safe-y"
```

**Step 2: Verify build**

Run: `npm run build`
Expected: SUCCESS

**Step 3: Commit**

```bash
git add src/shared/ui/drawer/ui/Drawer.vue
git commit -m "fix: add safe-area padding to Drawer for notch/gesture bar compatibility"
```

---

### Task 6: Create WindowInsetsHelper utility for native Android Activities

**Files:**
- Create: `android/app/src/main/java/com/forta/chat/utils/WindowInsetsHelper.kt`

**Step 1: Write the helper**

```kotlin
package com.forta.chat.utils

import android.app.Activity
import android.os.Build
import android.view.View
import android.view.WindowManager
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

object WindowInsetsHelper {

    /**
     * Enable edge-to-edge mode for an Activity, then apply real system bar
     * insets as padding to the designated top / bottom views.
     */
    fun setupEdgeToEdge(
        activity: Activity,
        topView: View? = null,
        bottomView: View? = null,
        onInsets: ((top: Int, bottom: Int, left: Int, right: Int) -> Unit)? = null
    ) {
        WindowCompat.setDecorFitsSystemWindows(activity.window, false)

        // Make system bars translucent
        activity.window.statusBarColor = android.graphics.Color.TRANSPARENT
        activity.window.navigationBarColor = android.graphics.Color.TRANSPARENT

        val rootView = activity.findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(rootView) { _, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())

            topView?.setPadding(
                topView.paddingLeft,
                systemBars.top,
                topView.paddingRight,
                topView.paddingBottom
            )

            bottomView?.setPadding(
                bottomView.paddingLeft,
                bottomView.paddingTop,
                bottomView.paddingRight,
                systemBars.bottom
            )

            onInsets?.invoke(systemBars.top, systemBars.bottom, systemBars.left, systemBars.right)

            insets
        }
    }
}
```

**Step 2: Verify compilation**

Run: `cd android && ./gradlew compileDebugKotlin`
Expected: BUILD SUCCESSFUL

**Step 3: Commit**

```bash
git add android/app/src/main/java/com/forta/chat/utils/WindowInsetsHelper.kt
git commit -m "feat: add WindowInsetsHelper utility for edge-to-edge inset handling"
```

---

### Task 7: Fix CallActivity — replace hardcoded padding with real WindowInsets

**Files:**
- Modify: `android/app/src/main/java/com/forta/chat/plugins/calls/CallActivity.kt:125-142`
- Modify: `android/app/src/main/res/layout/activity_call.xml:19,31,60`

**Context:** CallActivity uses `paddingTop="48dp"` on top bar, `paddingBottom="48dp"` on controls bar, and `marginTop="48dp"` on local video. These hardcoded values don't match actual system bar sizes on most devices.

**Step 1: Remove hardcoded padding from layout XML**

In `activity_call.xml`:

Line 19 — local video marginTop: change `android:layout_marginTop="48dp"` to `android:layout_marginTop="16dp"`

Line 31 — top_bar paddingTop: change `android:paddingTop="48dp"` to `android:paddingTop="0dp"`

Line 60 — controls_bar paddingBottom: change `android:paddingBottom="48dp"` to `android:paddingBottom="0dp"`

**Step 2: Add WindowInsetsHelper call in CallActivity.kt**

In `CallActivity.kt`, add import at the top:

```kotlin
import android.widget.FrameLayout
import com.forta.chat.utils.WindowInsetsHelper
```

In `onCreate()`, after `setupListeners()` call (after line 143), add:

```kotlin
        // Apply real system bar insets instead of hardcoded 48dp
        WindowInsetsHelper.setupEdgeToEdge(
            activity = this,
            topView = topBar,
            bottomView = controlsBar,
            onInsets = { top, _, _, _ ->
                val lp = localVideoView.layoutParams as FrameLayout.LayoutParams
                lp.topMargin = top + (16 * resources.displayMetrics.density).toInt()
                localVideoView.layoutParams = lp
            }
        )
```

Note: `bindViews()` is called before this, so `topBar`, `controlsBar`, and `localVideoView` are already initialized.

**Step 3: Verify compilation**

Run: `cd android && ./gradlew compileDebugKotlin`
Expected: BUILD SUCCESSFUL

**Step 4: Commit**

```bash
git add android/app/src/main/res/layout/activity_call.xml
git add android/app/src/main/java/com/forta/chat/plugins/calls/CallActivity.kt
git commit -m "fix: replace hardcoded 48dp padding in CallActivity with real WindowInsets"
```

---

### Task 8: Fix IncomingCallActivity — replace hardcoded margin with real WindowInsets

**Files:**
- Modify: `android/app/src/main/java/com/forta/chat/plugins/calls/IncomingCallActivity.kt:65-84`
- Modify: `android/app/src/main/res/layout/activity_incoming_call.xml:91-96`

**Context:** IncomingCallActivity uses `marginBottom="80dp"` on the buttons container. This doesn't account for actual navigation bar height.

**Step 1: Add id to buttons container in layout XML**

In `activity_incoming_call.xml`, line 91, add an id to the buttons LinearLayout:

```xml
<LinearLayout
    android:id="@+id/buttons_container"
    android:layout_width="match_parent"
    android:layout_height="wrap_content"
    android:orientation="horizontal"
    android:gravity="center"
    android:layout_marginBottom="32dp">
```

Change `android:layout_marginBottom="80dp"` to `android:layout_marginBottom="32dp"` — the remaining space will come from the navigation bar inset.

**Step 2: Add WindowInsetsHelper call in IncomingCallActivity.kt**

Add import at the top:

```kotlin
import android.widget.LinearLayout
import com.forta.chat.utils.WindowInsetsHelper
```

In `onCreate()`, after `setContentView(R.layout.activity_incoming_call)` (after line 85), add:

```kotlin
        // Apply real system bar insets
        WindowInsetsHelper.setupEdgeToEdge(
            activity = this,
            onInsets = { _, bottom, _, _ ->
                val buttonsContainer = findViewById<LinearLayout>(R.id.buttons_container)
                val lp = buttonsContainer.layoutParams as LinearLayout.LayoutParams
                lp.bottomMargin = bottom + (32 * resources.displayMetrics.density).toInt()
                buttonsContainer.layoutParams = lp
            }
        )
```

**Step 3: Verify compilation**

Run: `cd android && ./gradlew compileDebugKotlin`
Expected: BUILD SUCCESSFUL

**Step 4: Commit**

```bash
git add android/app/src/main/res/layout/activity_incoming_call.xml
git add android/app/src/main/java/com/forta/chat/plugins/calls/IncomingCallActivity.kt
git commit -m "fix: replace hardcoded 80dp margin in IncomingCallActivity with real WindowInsets"
```

---

### Task 9: Final verification

**Step 1: Full build check**

Run: `npm run build`
Expected: SUCCESS

**Step 2: Type check**

Run: `npx vue-tsc --noEmit`
Expected: SUCCESS — no type errors

**Step 3: Lint**

Run: `npm run lint`
Expected: SUCCESS

**Step 4: Android build**

Run: `cd android && ./gradlew assembleDebug`
Expected: BUILD SUCCESSFUL

**Step 5: Tests**

Run: `npm run test`
Expected: All tests pass

---

## Test Checklist (Manual QA)

After deployment, verify on real devices:

### Devices needed:
- Device with notch (Pixel 6+, Samsung S21+)
- Device without notch (older device or emulator API 28)
- Test with gesture navigation enabled
- Test with 3-button navigation

### Screens to verify:

**MediaViewer (photo viewer):**
- [ ] ✕ close button visible and tappable on notch device
- [ ] Caption text not overlapped by gesture bar
- [ ] Swipe-to-dismiss still works
- [ ] Navigation arrows accessible

**CallActivity (native video call):**
- [ ] Caller name visible below status bar on all devices
- [ ] Mute/Video/Flip/Speaker buttons above navigation bar
- [ ] Hangup button fully tappable
- [ ] Local video preview not under status bar
- [ ] PiP mode works correctly

**IncomingCallActivity (native):**
- [ ] Accept/Decline buttons visible above gesture bar
- [ ] Avatar and caller name not under status bar

**CallWindow (web call):**
- [ ] Minimize button below status bar
- [ ] Call controls above gesture bar
- [ ] Screen sharing badge visible

**BottomSheet (attachment panel, etc.):**
- [ ] Bottom content not under gesture bar
- [ ] All buttons in bottom sheet tappable

**Drawer:**
- [ ] Top content not under notch/status bar

**General:**
- [ ] Toast notifications properly positioned
- [ ] BottomTabBar correctly padded
- [ ] Chat input bar accessible (covered by MainLayout safe-bottom)
- [ ] Portrait and landscape orientation
- [ ] With keyboard open and closed
