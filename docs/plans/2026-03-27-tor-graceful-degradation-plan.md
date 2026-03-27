# Tor Graceful Degradation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Tor init non-blocking so users can always enter the app, even when Tor fails to bootstrap.

**Architecture:** Tor init runs as a best-effort background task during boot. If it doesn't complete within 90s (or stalls for 20s), the app continues without Tor. A toast notifies the user. When Tor eventually connects, traffic switches automatically.

**Tech Stack:** Vue 3, TypeScript, Capacitor (Android), Pinia, Kotlin

---

### Task 1: Make Tor init non-blocking in providers

**Files:**
- Modify: `src/app/providers/index.ts:35-65`

**Step 1: Replace blocking Tor init with fire-and-forget**

Replace the current blocking `await withTimeout(torService.init('always'), 30_000, "Tor init")` with a non-blocking approach that lets the app continue regardless of Tor outcome.

```typescript
// src/app/providers/index.ts — replace lines 59-65 with:

    // Start Tor daemon — non-blocking.
    // App continues even if Tor fails; traffic goes direct until Tor is ready.
    bootStatus.setStep("tor");
    const { torService } = await import('@/shared/lib/tor');
    torService.initBackground();
    useTorStore().init();
```

**Step 2: Verify build compiles**

Run: `npx vue-tsc --noEmit`
Expected: may fail until Task 2 adds `initBackground()`

---

### Task 2: Add `initBackground()` to TorService

**Files:**
- Modify: `src/shared/lib/tor/tor-service.ts`

**Step 1: Write the `initBackground` method**

Add to `TorService` class — starts Tor daemon without blocking. Monitors progress and sets `_ready` when done. If Tor fails or stalls, the service stays in not-ready state but doesn't throw.

```typescript
// Add after the existing init() method in TorService:

  private _initFailed = ref(false);
  private _initPromise: Promise<void> | null = null;
  readonly initFailed = readonly(this._initFailed);

  /**
   * Start Tor in background — never throws, never blocks boot.
   * Sets isReady=true when bootstrap completes.
   * Sets initFailed=true if Tor cannot start within time limits.
   */
  initBackground(): void {
    if (!isNative) {
      this._ready.value = true;
      return;
    }

    this._initFailed.value = false;
    this._initPromise = this._startWithStallDetection()
      .then(() => {
        console.log('[TOR] Background init succeeded');
      })
      .catch((err) => {
        console.warn('[TOR] Background init failed:', err.message);
        this._initFailed.value = true;
      });
  }

  private async _startWithStallDetection(): Promise<void> {
    const MAX_WAIT = 90_000;
    const STALL_TIMEOUT = 20_000;

    // Register listeners first
    await TorNative.addListener('bootstrapProgress', ({ progress }) => {
      this._progress.value = progress;
    });
    await TorNative.addListener('stateChanged', ({ state }) => {
      this._state.value = state;
      this._ready.value = state === 'RUNNING';
    });

    // Fire off the daemon start
    const startPromise = TorNative.startDaemon({ mode: 'always' })
      .then((result) => {
        this._proxyPort.value = result.proxyPort;
        this._ready.value = true;
      });

    // Stall detection: reject if no progress for STALL_TIMEOUT or total > MAX_WAIT
    const startTime = Date.now();
    let lastProgress = 0;
    let lastProgressTime = startTime;

    await new Promise<void>((resolve, reject) => {
      const check = setInterval(() => {
        const now = Date.now();
        const currentProgress = this._progress.value;

        if (this._ready.value) {
          clearInterval(check);
          resolve();
          return;
        }

        if (currentProgress > lastProgress) {
          lastProgress = currentProgress;
          lastProgressTime = now;
        }

        const totalElapsed = now - startTime;
        const stallElapsed = now - lastProgressTime;

        if (totalElapsed > MAX_WAIT) {
          clearInterval(check);
          reject(new Error(`Tor init timed out after ${MAX_WAIT / 1000}s (bootstrap at ${currentProgress}%)`));
        } else if (stallElapsed > STALL_TIMEOUT && currentProgress > 0 && currentProgress < 100) {
          clearInterval(check);
          reject(new Error(`Tor bootstrap stalled at ${currentProgress}% (no progress for ${STALL_TIMEOUT / 1000}s)`));
        }
      }, 2000);

      // Also resolve if startPromise finishes
      startPromise.then(() => { clearInterval(check); resolve(); })
                  .catch((err) => { clearInterval(check); reject(err); });
    });
  }
```

**Step 2: Update imports**

Add `readonly` import if not present (it's already imported).

**Step 3: Run type check**

Run: `npx vue-tsc --noEmit`
Expected: PASS

---

### Task 3: Show toast when Tor init fails

**Files:**
- Modify: `src/app/providers/index.ts:35-65`

**Step 1: Watch for Tor failure and show toast after app mounts**

After `torService.initBackground()`, set up a watcher that fires a toast when Tor fails. The toast system is already in App.vue. We use a simple approach: store a flag, and `App.vue` watches it.

```typescript
// In src/app/providers/index.ts, after torService.initBackground():

    // Notify user if Tor fails to start (after app is mounted)
    const torWatch = watch(
      () => torService.initFailed.value,
      (failed) => {
        if (failed) {
          // Import dynamically to avoid circular deps
          import('@/shared/lib/use-toast').then(({ useToast }) => {
            const { toast } = useToast();
            toast(
              'Secure connection unavailable. You can enable Tor in Settings.',
              'error',
              8000,
            );
          });
          torWatch(); // stop watching
        }
      },
    );
```

**Step 2: Verify build**

Run: `npx vue-tsc --noEmit`
Expected: PASS

---

### Task 4: Add pre-checks to Android TorManager

**Files:**
- Modify: `android/app/src/main/java/com/forta/chat/plugins/tor/TorManager.kt`

**Step 1: Add lock file cleanup and port check before Tor spawn**

Add pre-checks in `startTor()` after `config.ensureGeoIPFiles()` and before spawning the process:

```kotlin
// Add after config.ensureGeoIPFiles() in startTor():

        // Pre-check: remove stale lock file from previous crash
        val lockFile = java.io.File(config.torDataDir, "lock")
        if (lockFile.exists()) {
            Log.w(TAG, "Removing stale Tor lock file")
            lockFile.delete()
        }

        // Pre-check: kill process using SOCKS port if still running
        try {
            val socket = java.net.Socket()
            socket.connect(java.net.InetSocketAddress("127.0.0.1", config.torDefaultSocksPort), 500)
            socket.close()
            Log.w(TAG, "SOCKS port ${config.torDefaultSocksPort} already in use — killing stale process")
            // Force kill via PID file
            val pidFile = java.io.File(config.torPidPath)
            if (pidFile.exists()) {
                val pid = pidFile.readText().trim().toIntOrNull()
                if (pid != null) {
                    try { Runtime.getRuntime().exec(arrayOf("kill", "-9", pid.toString())) } catch (_: Exception) {}
                }
                pidFile.delete()
            }
            Thread.sleep(1000)
        } catch (_: Exception) {
            // Port is free — good
        }
```

**Step 2: Add elapsed time logging**

Add timestamp logging at key points in `startTor()`:

```kotlin
// At the beginning of startTor():
        val bootStart = android.os.SystemClock.elapsedRealtime()
        fun elapsed() = android.os.SystemClock.elapsedRealtime() - bootStart

// After ensureGeoIPFiles:
        Log.i(TAG, "[BOOT] T+${elapsed()}ms geoip files ready")

// After writing torrc:
        Log.i(TAG, "[BOOT] T+${elapsed()}ms torrc written")

// In onStdOutput bootstrap callback:
        Log.i(TAG, "[BOOT] T+${elapsed()}ms Bootstrap $pct%")

// When RUNNING:
        Log.i(TAG, "[BOOT] T+${elapsed()}ms Tor RUNNING, reverse proxy starting")
```

**Step 3: Build Android project**

Run: `cd android && ./gradlew assembleDebug 2>&1 | tail -5`
Expected: BUILD SUCCESSFUL

---

### Task 5: Add `clearTorCache` to Android TorPlugin

**Files:**
- Modify: `android/app/src/main/java/com/forta/chat/plugins/tor/TorPlugin.kt`
- Modify: `src/shared/lib/tor/tor-service.ts`

**Step 1: Add clearTorCache method to TorPlugin.kt**

```kotlin
// Add to TorPlugin.kt after verifyTor method:

    @PluginMethod
    fun clearTorCache(call: PluginCall) {
        Thread {
            try {
                torManager.stopTor()
                val dataDir = java.io.File(config.torDataDir)
                if (dataDir.exists()) {
                    dataDir.deleteRecursively()
                    Log.i("TorPlugin", "Tor data directory cleared: ${config.torDataDir}")
                }
                call.resolve()
            } catch (e: Exception) {
                call.reject("Failed to clear Tor cache: ${e.message}", e)
            }
        }.start()
    }
```

**Step 2: Add clearCache to TorNativePlugin interface and TorService**

```typescript
// In tor-service.ts, add to TorNativePlugin interface:
  clearTorCache(): Promise<void>;

// Add method to TorService class:
  async clearCache(): Promise<void> {
    if (!isNative) return;
    await TorNative.clearTorCache();
  }
```

**Step 3: Build and type-check**

Run: `npx vue-tsc --noEmit`
Expected: PASS

---

### Task 6: Add i18n strings for Tor failure notification

**Files:**
- Modify: `src/shared/lib/i18n/locales/en.ts`
- Modify: `src/shared/lib/i18n/locales/ru.ts`

**Step 1: Add English strings**

```typescript
// Add after "tor.disableWarning" in en.ts:
  "tor.initFailed": "Secure connection unavailable. You can enable Tor in Settings.",
```

**Step 2: Add Russian strings**

```typescript
// Add after "tor.disableWarning" in ru.ts:
  "tor.initFailed": "Безопасное соединение недоступно. Включите Tor в Настройках.",
```

---

### Task 7: Update existing Tor init() to not duplicate listeners

**Files:**
- Modify: `src/shared/lib/tor/tor-service.ts`

**Step 1: Prevent double listener registration**

Since `initBackground()` registers listeners and `init()` also does, we need a guard:

```typescript
// Add to TorService class:
  private _listenersRegistered = false;

// Modify the listener registration in both init() and _startWithStallDetection():
  private async _registerListeners(): Promise<void> {
    if (this._listenersRegistered) return;
    this._listenersRegistered = true;

    await TorNative.addListener('bootstrapProgress', ({ progress }) => {
      this._progress.value = progress;
    });
    await TorNative.addListener('stateChanged', ({ state }) => {
      this._state.value = state;
      this._ready.value = state === 'RUNNING';
    });
  }
```

Then use `this._registerListeners()` in both `init()` and `_startWithStallDetection()`.

**Step 2: Run type-check**

Run: `npx vue-tsc --noEmit`
Expected: PASS

---

### Task 8: Write tests for TorService initBackground

**Files:**
- Create: `src/shared/lib/tor/tor-service.test.ts`

**Step 1: Write tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Capacitor
vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    startDaemon: vi.fn(),
    stopDaemon: vi.fn(),
    getStatus: vi.fn(),
    configure: vi.fn(),
    verifyTor: vi.fn(),
    clearTorCache: vi.fn(),
    addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  }),
}));

// Mock platform
vi.mock('@/shared/lib/platform', () => ({
  isNative: false,
}));

describe('TorService', () => {
  it('initBackground resolves immediately on non-native', async () => {
    const { torService } = await import('./tor-service');
    torService.initBackground();
    expect(torService.isReady.value).toBe(true);
    expect(torService.initFailed.value).toBe(false);
  });
});
```

**Step 2: Run test**

Run: `npx vitest run src/shared/lib/tor/tor-service.test.ts`
Expected: PASS

---

### Task 9: Remove old Tor timeout from boot error path

**Files:**
- Modify: `src/app/providers/index.ts`

Ensure the `withTimeout` import for Tor is removed (keep it for chat scripts). The boot flow should no longer throw on Tor failure.

**Step 1: Clean up imports if unused**

If `withTimeout` is still used for scripts loading, keep import. Just verify Tor path no longer uses it.

**Step 2: Full verification**

Run all checks:
```bash
npm run build
npm run lint
npx vue-tsc --noEmit
npm run test
```
Expected: ALL PASS

---

### Task 10: Commit

**Step 1: Stage and commit**

```bash
git add -A
git commit -m "feat: make Tor init non-blocking — app loads even if Tor fails

- Tor bootstraps in background with 90s timeout + 20s stall detection
- App starts with direct connections if Tor unavailable
- Toast notifies user to enable Tor in Settings
- Android: pre-checks for stale lock files and occupied ports
- Android: clearTorCache plugin method for targeted cache reset
- Added elapsed-time tracing to Tor bootstrap for diagnostics"
```
