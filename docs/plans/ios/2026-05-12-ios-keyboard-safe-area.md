# iOS Keyboard, Safe Area, Status Bar Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Parent plan:** `2026-05-12-ios-overall-plan.md`

**Goal:** Provide correct keyboard offset, safe area, and status bar behavior on iOS using **stock Capacitor plugins** instead of replicating the Android `MainActivity.injectAllCssVars` pipeline.

---

## Critical reassessment

The Android `MainActivity.kt:209-238` `injectAllCssVars()` exists because:

- Android edge-to-edge has buggy IME-inset reporting on Xiaomi/MIUI, Infinix XOS, Tecno HiOS.
- WebView versions vary across devices and don't dispatch insets reliably after `WindowInsetsCompat` listener.
- `position: fixed` + `adjustNothing` requires us to inject `--keyboardheight` manually so CSS can shrink the chat shell.

**None of these problems exist on iOS:**

| Concern | iOS reality |
|---|---|
| Safe area / notch insets | `env(safe-area-inset-top)`, `env(safe-area-inset-bottom)` etc. work natively in WKWebView. Verified by the maintainer of `@capacitor-community/safe-area`: "On web and iOS the safe area insets work perfectly fine out of the box." |
| Keyboard height | `@capacitor/keyboard` plugin emits `keyboardWillShow` / `keyboardWillHide` events with `keyboardHeight` payload; iOS-side uses `UIResponder.keyboardWillShowNotification`. Mature, well-tested. |
| Edge-to-edge | iOS WKWebView always renders behind the status bar; `viewport-fit=cover` in the meta tag gives us full-screen drawing without manual insets. |
| Status bar appearance | `@capacitor/status-bar` (already installed) handles light/dark icon switching and overlay mode. |

**Decision:** delete (i.e., do not port) the `MainActivity.injectAllCssVars` model on iOS. Use the standard plugin events to set `--keyboardheight` and rely on `env(safe-area-inset-*)` for everything else.

---

## Tasks

### Task 1: Install `@capacitor/keyboard`

**Files:**
- `package.json`
- `capacitor.config.ts`

**Step 1: Install**

```
npm install @capacitor/keyboard@^8
npx cap sync ios
npx cap sync android   # safe — Android keeps using our MainActivity inset injection; the plugin exposes events but doesn't take over insets when resize: 'none'
```

**Step 2: Configure**

Update `capacitor.config.ts`:

```typescript
plugins: {
  ...,
  Keyboard: {
    // Existing Android setting; iOS interprets this as KeyboardResize='none'
    // — i.e., do not resize the WebView, fire events instead. Matches our
    // architecture where CSS controls the chat shell shrink/grow.
    resize: 'none',
    resizeOnFullScreen: false,
  },
},
```

**Step 3: Verify build**

```
npm run build && npx cap sync
```

**Step 4: Commit**

```
git add package.json package-lock.json capacitor.config.ts
git commit -m "feat(keyboard): install @capacitor/keyboard plugin (iOS + Android event source)"
```

---

### Task 2: Replace Android-only `useKeyboardVisible` / `useKeyboardFallback` calls with the plugin's events

**Files:**
- Modify: `src/shared/lib/composables/use-keyboard-visible.ts`
- Modify: `src/shared/lib/composables/use-keyboard-fallback.ts`
- Audit consumers (search for `useKeyboardVisible`, `useKeyboardFallback`)

**Step 1: Use Capacitor Keyboard events on native, visualViewport on web**

```typescript
import { ref, onMounted, onUnmounted } from 'vue';
import { isNative } from '@/shared/lib/platform';

export function useKeyboardHeight() {
  const height = ref(0);
  let removeShow: (() => void) | undefined;
  let removeHide: (() => void) | undefined;

  onMounted(async () => {
    if (isNative) {
      const { Keyboard } = await import('@capacitor/keyboard');
      const showHandle = await Keyboard.addListener('keyboardWillShow', (info) => {
        height.value = info.keyboardHeight;
      });
      const hideHandle = await Keyboard.addListener('keyboardWillHide', () => {
        height.value = 0;
      });
      removeShow = () => showHandle.remove();
      removeHide = () => hideHandle.remove();
    } else {
      // Web fallback — visualViewport
      const vv = window.visualViewport;
      if (!vv) return;
      const onResize = () => { height.value = Math.max(0, window.innerHeight - vv.height); };
      vv.addEventListener('resize', onResize);
      removeShow = () => vv.removeEventListener('resize', onResize);
    }
  });

  onUnmounted(() => { removeShow?.(); removeHide?.(); });

  return height;
}
```

**Step 2: Drive the existing CSS variable from JS on iOS**

Android side already sets `--keyboardheight` via `MainActivity.injectAllCssVars`. On iOS, set it from the composable:

```typescript
import { watch } from 'vue';
import { useKeyboardHeight } from '@/shared/lib/composables/use-keyboard-visible';
import { isIOS } from '@/shared/lib/platform';

export function installIOSKeyboardCssVar() {
  if (!isIOS) return;
  const h = useKeyboardHeight();
  watch(h, (v) => {
    document.documentElement.style.setProperty('--keyboardheight', `${v}px`);
    document.documentElement.style.setProperty('--app-bottom-inset', `${v}px`);
    // safe-area-inset-bottom = 0 when keyboard is open (matches MainActivity logic)
    document.documentElement.style.setProperty(
      '--safe-area-inset-bottom-effective',
      v > 0 ? '0px' : 'env(safe-area-inset-bottom)'
    );
  }, { immediate: true });
}
```

Call `installIOSKeyboardCssVar()` from `src/main.ts` once at app boot (after the auth/store init, on mount).

**Step 3: Update CSS to read the new effective var**

In `src/app/styles/main.css`, where Android CSS reads `var(--safe-area-inset-bottom)` directly, switch to `var(--safe-area-inset-bottom-effective, env(safe-area-inset-bottom))`. Single sweep across the file. Matches Android effective-bottom semantics.

**Step 4: Verify**

- Open chat on iOS device. Tap input. Keyboard slides up. Composer should sit on top of keyboard (above) without visible gap.
- Tap message in scroller. Long-press menu opens. Keyboard hides. Layout returns. No flicker.
- Rotate landscape. Same.

**Step 5: Commit**

```
git add src/shared/lib/composables/use-keyboard-visible.ts src/shared/lib/composables/use-keyboard-fallback.ts src/main.ts src/app/styles/main.css
git commit -m "feat(ios): drive --keyboardheight from @capacitor/keyboard events"
```

---

### Task 3: Status bar appearance via `@capacitor/status-bar`

**Files:**
- Modify: `src/app/providers/initializers/app-initializer.ts` (or wherever theme switches happen)
- Modify: `src/entities/theme/model/stores.ts`

**Step 1: Switch status bar style with theme**

```typescript
import { StatusBar, Style } from '@capacitor/status-bar';
import { isNative } from '@/shared/lib/platform';
...
async function applyStatusBarTheme(isDark: boolean) {
  if (!isNative) return;
  try {
    await StatusBar.setStyle({ style: isDark ? Style.Light : Style.Dark });
    // Android also sets background color; on iOS this is a no-op.
    await StatusBar.setBackgroundColor({ color: isDark ? '#000000' : '#ffffff' });
    await StatusBar.setOverlaysWebView({ overlay: true });
  } catch (e) {
    console.warn('[StatusBar] failed to apply theme:', e);
  }
}
```

Wire it to the theme store's watcher.

**Step 2: Remove Android `MainActivity.applyStatusBarAppearance` redundancy**

The Android MainActivity already does this on the native side — but having two paths is fine; the JS path is harmless on Android since `StatusBar.setStyle` just instructs the system controller. **Don't delete the Kotlin** — it's the bootstrap path that fires before JS is ready.

**Step 3: Verify**

Toggle dark/light theme in Settings, status bar icons flip color immediately on both platforms.

**Step 4: Commit**

```
git add src/app/providers/initializers/app-initializer.ts src/entities/theme/model/stores.ts
git commit -m "feat(ios): apply status bar style from theme store"
```

---

### Task 4: viewport-fit=cover meta tag

**Files:**
- Modify: `index.html`

**Step 1: Ensure viewport meta tag has `viewport-fit=cover`**

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no" />
```

Without `viewport-fit=cover`, `env(safe-area-inset-*)` returns 0 on iOS — the page draws inside the safe area instead of edge-to-edge.

**Step 2: Commit**

```
git add index.html
git commit -m "feat(ios): viewport-fit=cover for env(safe-area-inset-*) support"
```

---

### Task 5: Disable `MainActivity` reinjection on iOS (no-op, paper change)

**Files:**
- Confirm: `src/global.d.ts` and any place reading `--keyboardheight` work uniformly.

The Android `MainActivity.injectAllCssVars` only runs in the Android process. iOS process never instantiates it. **No code change required**, just verify by inspection. Document in the PR.

---

### Task 6: WebView scroll behavior

**Files:**
- Modify: `capacitor.config.ts`

**Step 1: Disable bounce / overscroll on iOS**

Add to `capacitor.config.ts`:

```typescript
ios: {
  contentInset: 'never',
  scrollEnabled: false,
  // Prevent WKWebView's built-in scroll from competing with our virtual scroller
  webContentsDebuggingEnabled: false, // set true during development only
},
```

`contentInset: 'never'` prevents WKWebView from automatically padding the top by the status bar height — our CSS does it via `env(safe-area-inset-top)`.

**Step 2: Commit**

```
git add capacitor.config.ts
git commit -m "feat(ios): disable WKWebView default scroll and content inset"
```

---

## Verification gate (end of plan)

- [ ] `npm run build` — green.
- [ ] `npx vitest run src/shared/lib/composables/` — green.
- [ ] Real-device matrix:
  - [ ] iPhone 15 Pro (notch + Dynamic Island): chat content draws edge-to-edge, no overlap with status bar / home indicator, composer above keyboard.
  - [ ] iPhone SE (no notch): same.
  - [ ] iPad split-screen: keyboard shows in floating mode, composer adjusts.
  - [ ] Dark theme → light theme: status bar icons flip without app restart.
  - [ ] Rotate to landscape mid-chat: layout reflows, no clipped UI.

## Out of scope

- Stage Manager / external display layouts on iPad — known to be tricky; not v1.
- Software keyboard themes or custom keyboard accessory views — not requested.

