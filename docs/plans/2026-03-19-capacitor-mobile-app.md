# Capacitor Mobile App (Android) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port the Vue 3 web chat into a native Android app with Tor routing, push notifications, native calls, and streaming media upload.

**Architecture:** Capacitor wraps the existing Vue app in Android WebView. Four native Kotlin plugins (Tor, Push, Calls, FileTransfer) bridge to the JS layer. Tor traffic flows through `libreverseproxy.so` (HTTP→SOCKS bridge on :8181). Matrix SDK switches `baseUrl` to `localhost:8181` when Tor is active. Push uses FCM data-only messages with local decryption. Calls use Android ConnectionService for lock-screen UI.

**Tech Stack:** Capacitor 6, Kotlin, Android SDK 34, OkHttp, Tor native binaries from Pocketnet, Vue 3, Pinia, matrix-js-sdk-bastyon, Dexie.js

**Source reference:** Tor plugin forked from `/Users/daniilkim/work/pocketnet/cordova/plugins/cordova-plugin-tor-runner/`

---

## Phase 1: Capacitor Scaffold & Platform Abstraction

### Task 1: Initialize Capacitor in the project

**Files:**
- Create: `capacitor.config.ts`
- Modify: `package.json` (add dependencies)
- Generated: `android/` directory

**Step 1: Install Capacitor packages**

```bash
npm install @capacitor/core @capacitor/cli @capacitor/app @capacitor/haptics @capacitor/status-bar
```

**Step 2: Initialize Capacitor**

```bash
npx cap init "Bastyon Chat" com.bastyon.chat --web-dir dist
```

**Step 3: Create capacitor.config.ts**

```typescript
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.bastyon.chat',
  appName: 'Bastyon Chat',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    buildOptions: {
      keystorePath: undefined,
      keystoreAlias: undefined,
    },
  },
};

export default config;
```

**Step 4: Add Android platform**

```bash
npx cap add android
```

**Step 5: Build Vue app and sync**

```bash
npm run build && npx cap sync android
```

**Step 6: Verify Android project opens**

```bash
npx cap open android
```

Expected: Android Studio opens with the project. WebView loads the Vue app.

**Step 7: Add build scripts to package.json**

Add to `scripts` section:
```json
{
  "cap:build": "vue-tsc --noEmit && vite build && npx cap sync android",
  "cap:open": "npx cap open android",
  "cap:run": "npx cap run android"
}
```

**Step 8: Commit**

```bash
git add capacitor.config.ts package.json package-lock.json android/
git commit -m "feat: initialize Capacitor with Android platform"
```

---

### Task 2: Platform abstraction layer

**Files:**
- Create: `src/shared/lib/platform/index.ts`
- Modify: `src/app/providers/index.ts` (use platform abstraction)

**Step 1: Create platform detection module**

Create `src/shared/lib/platform/index.ts`:

```typescript
import { Capacitor } from '@capacitor/core';

/** True when running inside a native Capacitor shell (Android/iOS). */
export const isNative = Capacitor.isNativePlatform();

/** True on Android specifically. */
export const isAndroid = Capacitor.getPlatform() === 'android';

/** True on iOS specifically. */
export const isIOS = Capacitor.getPlatform() === 'ios';

/** True in Electron desktop app. */
export const isElectron = !!(window as any).electronAPI?.isElectron;

/** True in plain browser (no native shell). */
export const isWeb = !isNative && !isElectron;

/** Current platform name for logging/analytics. */
export type Platform = 'android' | 'ios' | 'electron' | 'web';
export const currentPlatform: Platform = isAndroid
  ? 'android'
  : isIOS
    ? 'ios'
    : isElectron
      ? 'electron'
      : 'web';
```

**Step 2: Update app providers to use platform module**

Modify `src/app/providers/index.ts`. Replace the Electron-specific block:

Find:
```typescript
if (window.electronAPI?.isElectron) {
```

Replace with:
```typescript
import { isElectron, isNative } from '@/shared/lib/platform';

// ... in setupProviders():
if (isElectron) {
```

Add after the Electron block:
```typescript
if (isNative) {
  // Capacitor-specific initialization will go here (Tor, Push, etc.)
  // Placeholder — filled in Phase 2+
}
```

**Step 3: Verify build passes**

```bash
npx vue-tsc --noEmit
```

Expected: No new TypeScript errors.

**Step 4: Commit**

```bash
git add src/shared/lib/platform/
git commit -m "feat: add platform abstraction layer for web/electron/android"
```

---

## Phase 2: Tor Plugin (fork of cordova-plugin-tor-runner)

### Task 3: Copy native binaries and GeoIP files from Pocketnet

**Files:**
- Create: `android/app/src/main/jniLibs/arm64-v8a/*.so`
- Create: `android/app/src/main/jniLibs/armeabi-v7a/*.so`
- Create: `android/app/src/main/assets/tor/geoip`
- Create: `android/app/src/main/assets/tor/geoip6`

**Step 1: Copy .so binaries**

```bash
# arm64-v8a
mkdir -p android/app/src/main/jniLibs/arm64-v8a
cp ../pocketnet/cordova/plugins/cordova-plugin-tor-runner/jniLibs/arm64-v8a/libtor.so \
   ../pocketnet/cordova/plugins/cordova-plugin-tor-runner/jniLibs/arm64-v8a/libreverseproxy.so \
   ../pocketnet/cordova/plugins/cordova-plugin-tor-runner/jniLibs/arm64-v8a/libobfs4proxy.so \
   ../pocketnet/cordova/plugins/cordova-plugin-tor-runner/jniLibs/arm64-v8a/libsnowflake.so \
   ../pocketnet/cordova/plugins/cordova-plugin-tor-runner/jniLibs/arm64-v8a/libconjure.so \
   ../pocketnet/cordova/plugins/cordova-plugin-tor-runner/jniLibs/arm64-v8a/libzmq.so \
   ../pocketnet/cordova/plugins/cordova-plugin-tor-runner/jniLibs/arm64-v8a/libc++_shared.so \
   android/app/src/main/jniLibs/arm64-v8a/

# armeabi-v7a
mkdir -p android/app/src/main/jniLibs/armeabi-v7a
cp ../pocketnet/cordova/plugins/cordova-plugin-tor-runner/jniLibs/armeabi-v7a/libtor.so \
   ../pocketnet/cordova/plugins/cordova-plugin-tor-runner/jniLibs/armeabi-v7a/libreverseproxy.so \
   ../pocketnet/cordova/plugins/cordova-plugin-tor-runner/jniLibs/armeabi-v7a/libobfs4proxy.so \
   ../pocketnet/cordova/plugins/cordova-plugin-tor-runner/jniLibs/armeabi-v7a/libsnowflake.so \
   ../pocketnet/cordova/plugins/cordova-plugin-tor-runner/jniLibs/armeabi-v7a/libconjure.so \
   ../pocketnet/cordova/plugins/cordova-plugin-tor-runner/jniLibs/armeabi-v7a/libzmq.so \
   ../pocketnet/cordova/plugins/cordova-plugin-tor-runner/jniLibs/armeabi-v7a/libc++_shared.so \
   android/app/src/main/jniLibs/armeabi-v7a/
```

**Step 2: Copy GeoIP files**

```bash
# Find and copy geoip files from pocketnet
mkdir -p android/app/src/main/assets/tor
find ../pocketnet -name "geoip" -not -path "*/node_modules/*" | head -1 | xargs -I{} cp {} android/app/src/main/assets/tor/geoip
find ../pocketnet -name "geoip6" -not -path "*/node_modules/*" | head -1 | xargs -I{} cp {} android/app/src/main/assets/tor/geoip6
```

**Step 3: Verify binaries are in place**

```bash
ls -la android/app/src/main/jniLibs/arm64-v8a/
ls -la android/app/src/main/jniLibs/armeabi-v7a/
ls -la android/app/src/main/assets/tor/
```

Expected: 7 .so files per arch, 2 geoip files.

**Step 4: Commit**

```bash
git add android/app/src/main/jniLibs/ android/app/src/main/assets/tor/
git commit -m "feat: add Tor native binaries and GeoIP from pocketnet"
```

---

### Task 4: Port ConfigurationManager

**Files:**
- Create: `android/app/src/main/java/com/bastyon/chat/plugins/tor/ConfigurationManager.kt`

**Step 1: Create ConfigurationManager**

Adapted from Pocketnet's `ConfigurationManager.kt`, stripped of Dagger DI:

```kotlin
package com.bastyon.chat.plugins.tor

import android.content.Context

/**
 * Manages paths and ports for Tor and reverse proxy.
 * Ported from pocketnet cordova-plugin-tor-runner.
 */
class ConfigurationManager(private val context: Context) {

    val appDataDir: String
        get() = context.applicationInfo?.dataDir ?: context.filesDir.absolutePath

    val nativeLibPath: String
        get() = context.applicationInfo.nativeLibraryDir

    // --- Tor ---
    val torPath: String get() = "$nativeLibPath/libtor.so"
    val torConfDir: String get() = "$appDataDir/app_data/tor"
    val torConfPath: String get() = "$torConfDir/tor.conf"
    val torPidPath: String get() = "$torConfDir/tor.pid"
    val torDataDir: String get() = "$torConfDir/data"
    val torLogPath: String get() = "$appDataDir/logs/Tor.log"
    val geoipPath: String get() = "$torConfDir/geoip"
    val geoip6Path: String get() = "$torConfDir/geoip6"

    val torDefaultSocksPort: Int = 9051
    val torControlPort: Int = 9251

    // --- Reverse Proxy ---
    val reverseProxyPath: String get() = "$nativeLibPath/libreverseproxy.so"
    val reverseProxyPidPath: String get() = "$appDataDir/app_data/tor/rp.pid"
    val reverseProxyDefaultPort: Int = 8181

    // --- Bridge transports ---
    val obfs4proxyPath: String get() = "$nativeLibPath/libobfs4proxy.so"
    val snowflakePath: String get() = "$nativeLibPath/libsnowflake.so"
    val conjurePath: String get() = "$nativeLibPath/libconjure.so"

    /**
     * Copies GeoIP files from assets to the tor config dir.
     * Must be called once before starting Tor.
     */
    fun ensureGeoIPFiles() {
        val dir = java.io.File(torConfDir)
        if (!dir.exists()) dir.mkdirs()

        val dataDir = java.io.File(torDataDir)
        if (!dataDir.exists()) dataDir.mkdirs()

        copyAssetIfMissing("tor/geoip", geoipPath)
        copyAssetIfMissing("tor/geoip6", geoip6Path)
    }

    private fun copyAssetIfMissing(assetName: String, destPath: String) {
        val dest = java.io.File(destPath)
        if (dest.exists()) return
        context.assets.open(assetName).use { input ->
            dest.outputStream().use { output ->
                input.copyTo(output)
            }
        }
    }

    /**
     * Generates torrc content for the given settings.
     */
    fun generateTorrc(
        mode: TorMode = TorMode.ALWAYS,
        bridgeType: BridgeType = BridgeType.NONE,
        customBridges: List<String> = emptyList()
    ): String {
        val sb = StringBuilder()
        sb.appendLine("SocksPort $torDefaultSocksPort")
        sb.appendLine("ControlPort $torControlPort")
        sb.appendLine("CookieAuthentication 1")
        sb.appendLine("DataDirectory $torDataDir")
        sb.appendLine("GeoIPFile $geoipPath")
        sb.appendLine("GeoIPv6File $geoip6Path")
        sb.appendLine("AvoidDiskWrites 1")
        sb.appendLine("KeepalivePeriod 10")

        when (bridgeType) {
            BridgeType.OBFS4 -> {
                sb.appendLine("UseBridges 1")
                sb.appendLine("ClientTransportPlugin obfs4 exec $obfs4proxyPath")
                for (bridge in customBridges) {
                    sb.appendLine("Bridge $bridge")
                }
            }
            BridgeType.SNOWFLAKE -> {
                sb.appendLine("UseBridges 1")
                sb.appendLine("ClientTransportPlugin snowflake exec $snowflakePath")
                sb.appendLine("Bridge snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72 fingerprint=2B280B23E1107BB62ABFC40DDCC8824814F80A72 url=https://snowflake-broker.torproject.net/ fronts=cdn.sstatic.net,www.phpmyadmin.net ice=stun:stun.l.google.com:19302,stun:stun.antisip.com:3478,stun:stun.bluesip.net:3478,stun:stun.dus.net:3478,stun:stun.epygi.com:3478,stun:stun.sonetel.com:3478,stun:stun.uls.co.za:3478,stun:stun.voipgate.com:3478,stun:stun.voys.nl:3478 utls-imitate=hellorandomizedalpn")
            }
            else -> {}
        }

        return sb.toString()
    }
}

enum class TorMode { NEVER, AUTO, ALWAYS }
enum class BridgeType { NONE, VANILLA, OBFS4, SNOWFLAKE, WEBTUNNEL }
```

**Step 2: Verify compilation**

```bash
cd android && ./gradlew compileDebugKotlin 2>&1 | tail -5
```

Expected: BUILD SUCCESSFUL (or warnings only, no errors).

**Step 3: Commit**

```bash
git add android/app/src/main/java/com/bastyon/chat/plugins/tor/ConfigurationManager.kt
git commit -m "feat(tor): add ConfigurationManager with paths and torrc generation"
```

---

### Task 5: Port process execution helpers (StarterHelper equivalent)

**Files:**
- Create: `android/app/src/main/java/com/bastyon/chat/plugins/tor/ProcessRunner.kt`

**Step 1: Create ProcessRunner**

Simplified version of Pocketnet's `StarterHelper.java` + `ProcessStarter.java`, merged into one Kotlin class:

```kotlin
package com.bastyon.chat.plugins.tor

import android.util.Log
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.regex.Pattern

/**
 * Runs a native process and monitors its stdout/stderr.
 * Ported from pocketnet StarterHelper + ProcessStarter.
 */
class ProcessRunner(
    private val tag: String = "ProcessRunner"
) {
    private var process: Process? = null
    private var monitorThread: Thread? = null

    interface OutputListener {
        fun onStdOutput(line: String)
        fun onErrOutput(line: String)
    }

    /**
     * Start a native binary with the given arguments.
     * Blocks until the process exits (run on a background thread).
     */
    fun start(
        binaryPath: String,
        args: List<String>,
        env: Map<String, String> = emptyMap(),
        workDir: File? = null,
        listener: OutputListener? = null
    ): Int {
        val cmd = mutableListOf(binaryPath) + args
        val pb = ProcessBuilder(cmd)

        // Set LD_LIBRARY_PATH so Tor can find libc++_shared.so etc.
        val environment = pb.environment()
        for ((k, v) in env) {
            environment[k] = v
        }

        if (workDir != null) {
            pb.directory(workDir)
        }

        pb.redirectErrorStream(false)

        Log.d(tag, "Starting: ${cmd.joinToString(" ")}")
        process = pb.start()

        val proc = process!!

        // Monitor stdout
        monitorThread = Thread({
            try {
                BufferedReader(InputStreamReader(proc.inputStream)).use { reader ->
                    var line: String?
                    while (reader.readLine().also { line = it } != null) {
                        Log.d(tag, "[stdout] $line")
                        listener?.onStdOutput(line!!)
                    }
                }
            } catch (e: Exception) {
                Log.e(tag, "stdout reader error", e)
            }
        }, "$tag-stdout").also { it.isDaemon = true; it.start() }

        // Monitor stderr
        Thread({
            try {
                BufferedReader(InputStreamReader(proc.errorStream)).use { reader ->
                    var line: String?
                    while (reader.readLine().also { line = it } != null) {
                        Log.w(tag, "[stderr] $line")
                        listener?.onErrOutput(line!!)
                    }
                }
            } catch (e: Exception) {
                Log.e(tag, "stderr reader error", e)
            }
        }, "$tag-stderr").also { it.isDaemon = true; it.start() }

        return proc.waitFor()
    }

    fun stop() {
        process?.let {
            it.destroy()
            try { it.waitFor() } catch (_: Exception) {}
        }
        process = null
    }

    fun isRunning(): Boolean = process?.isAlive == true

    companion object {
        private val BOOTSTRAP_PATTERN = Pattern.compile("Bootstrapped (\\d+)%")

        /** Extract bootstrap percentage from a Tor stdout line, or null. */
        fun parseBootstrapPercent(line: String): Int? {
            val m = BOOTSTRAP_PATTERN.matcher(line)
            return if (m.find()) m.group(1)?.toInt() else null
        }
    }
}
```

**Step 2: Verify compilation**

```bash
cd android && ./gradlew compileDebugKotlin 2>&1 | tail -5
```

**Step 3: Commit**

```bash
git add android/app/src/main/java/com/bastyon/chat/plugins/tor/ProcessRunner.kt
git commit -m "feat(tor): add ProcessRunner for native binary execution"
```

---

### Task 6: Create TorManager (lifecycle orchestrator)

**Files:**
- Create: `android/app/src/main/java/com/bastyon/chat/plugins/tor/TorManager.kt`

**Step 1: Create TorManager**

```kotlin
package com.bastyon.chat.plugins.tor

import android.util.Log
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

enum class TorState { STOPPED, STARTING, RUNNING, STOPPING }

/**
 * Manages the Tor daemon and reverse proxy lifecycle.
 * Ported from pocketnet TorManager.java + ReverseProxyManager.java.
 */
class TorManager(private val config: ConfigurationManager) {

    private val TAG = "TorManager"
    private val lock = ReentrantLock()
    private val state = AtomicReference(TorState.STOPPED)
    private val bootstrapPercent = AtomicInteger(0)

    private val torRunner = ProcessRunner(tag = "Tor")
    private val proxyRunner = ProcessRunner(tag = "ReverseProxy")
    private var torThread: Thread? = null
    private var proxyThread: Thread? = null

    var onBootstrapProgress: ((Int) -> Unit)? = null
    var onStateChanged: ((TorState) -> Unit)? = null

    val currentState: TorState get() = state.get()
    val currentBootstrap: Int get() = bootstrapPercent.get()
    val isReady: Boolean get() = state.get() == TorState.RUNNING

    fun startTor(
        mode: TorMode = TorMode.ALWAYS,
        bridgeType: BridgeType = BridgeType.NONE,
        customBridges: List<String> = emptyList()
    ) {
        lock.withLock {
            if (state.get() != TorState.STOPPED) {
                Log.w(TAG, "Tor already ${state.get()}, ignoring start")
                return
            }
            setState(TorState.STARTING)
            bootstrapPercent.set(0)
        }

        // Ensure directories and geoip files
        config.ensureGeoIPFiles()

        // Write torrc
        val torrc = config.generateTorrc(mode, bridgeType, customBridges)
        File(config.torConfPath).apply {
            parentFile?.mkdirs()
            writeText(torrc)
        }

        // Make binary executable
        File(config.torPath).setExecutable(true)

        // Start Tor in background thread
        torThread = Thread({
            val exitCode = torRunner.start(
                binaryPath = config.torPath,
                args = listOf("-f", config.torConfPath, "--pidfile", config.torPidPath),
                env = mapOf("LD_LIBRARY_PATH" to config.nativeLibPath),
                listener = object : ProcessRunner.OutputListener {
                    override fun onStdOutput(line: String) {
                        val pct = ProcessRunner.parseBootstrapPercent(line)
                        if (pct != null) {
                            bootstrapPercent.set(pct)
                            onBootstrapProgress?.invoke(pct)
                            if (pct >= 100) {
                                startReverseProxy()
                                setState(TorState.RUNNING)
                            }
                        }
                    }
                    override fun onErrOutput(line: String) {
                        // Tor writes warnings to stderr, just log
                    }
                }
            )
            Log.d(TAG, "Tor process exited with code $exitCode")
            if (state.get() != TorState.STOPPING) {
                setState(TorState.STOPPED)
            }
        }, "TorThread").also { it.isDaemon = true; it.start() }
    }

    private fun startReverseProxy() {
        File(config.reverseProxyPath).setExecutable(true)

        proxyThread = Thread({
            val exitCode = proxyRunner.start(
                binaryPath = config.reverseProxyPath,
                args = listOf(
                    "-proxyport", config.reverseProxyDefaultPort.toString(),
                    "-sockport", config.torDefaultSocksPort.toString(),
                    "-pidfile", config.reverseProxyPidPath
                ),
                env = mapOf("LD_LIBRARY_PATH" to config.nativeLibPath)
            )
            Log.d(TAG, "ReverseProxy exited with code $exitCode")
        }, "ReverseProxyThread").also { it.isDaemon = true; it.start() }
    }

    fun stopTor() {
        lock.withLock {
            if (state.get() == TorState.STOPPED) return
            setState(TorState.STOPPING)
        }

        proxyRunner.stop()
        torRunner.stop()

        // Clean pid files
        File(config.torPidPath).delete()
        File(config.reverseProxyPidPath).delete()

        setState(TorState.STOPPED)
        bootstrapPercent.set(0)
    }

    fun restartTor(
        mode: TorMode = TorMode.ALWAYS,
        bridgeType: BridgeType = BridgeType.NONE,
        customBridges: List<String> = emptyList()
    ) {
        stopTor()
        startTor(mode, bridgeType, customBridges)
    }

    private fun setState(newState: TorState) {
        state.set(newState)
        onStateChanged?.invoke(newState)
        Log.d(TAG, "State → $newState")
    }
}
```

**Step 2: Verify compilation**

```bash
cd android && ./gradlew compileDebugKotlin 2>&1 | tail -5
```

**Step 3: Commit**

```bash
git add android/app/src/main/java/com/bastyon/chat/plugins/tor/TorManager.kt
git commit -m "feat(tor): add TorManager lifecycle orchestrator"
```

---

### Task 7: Create Capacitor TorPlugin (JS↔native bridge)

**Files:**
- Create: `android/app/src/main/java/com/bastyon/chat/plugins/tor/TorPlugin.kt`
- Modify: `android/app/src/main/java/com/bastyon/chat/MainActivity.kt` (register plugin)

**Step 1: Create TorPlugin.kt**

```kotlin
package com.bastyon.chat.plugins.tor

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "Tor")
class TorPlugin : Plugin() {

    private lateinit var config: ConfigurationManager
    private lateinit var torManager: TorManager

    override fun load() {
        config = ConfigurationManager(context)
        torManager = TorManager(config)

        torManager.onBootstrapProgress = { percent ->
            notifyListeners("bootstrapProgress", JSObject().apply {
                put("progress", percent)
            })
        }

        torManager.onStateChanged = { state ->
            notifyListeners("stateChanged", JSObject().apply {
                put("state", state.name)
            })
        }
    }

    @PluginMethod
    fun startDaemon(call: PluginCall) {
        val modeStr = call.getString("mode", "always") ?: "always"
        val bridgeStr = call.getString("bridgeType", "NONE") ?: "NONE"
        val bridges = call.getArray("bridges")
            ?.toList<String>() ?: emptyList()

        val mode = when (modeStr.lowercase()) {
            "never", "neveruse" -> TorMode.NEVER
            "auto" -> TorMode.AUTO
            else -> TorMode.ALWAYS
        }
        val bridgeType = try {
            BridgeType.valueOf(bridgeStr.uppercase())
        } catch (_: Exception) {
            BridgeType.NONE
        }

        if (mode == TorMode.NEVER) {
            call.resolve(JSObject().apply {
                put("socksPort", 0)
                put("proxyPort", 0)
                put("mode", "never")
            })
            return
        }

        Thread {
            try {
                torManager.startTor(mode, bridgeType, bridges)

                // Wait for bootstrap (max 120 seconds)
                val timeout = 120_000L
                val start = System.currentTimeMillis()
                while (!torManager.isReady && System.currentTimeMillis() - start < timeout) {
                    Thread.sleep(500)
                }

                if (torManager.isReady) {
                    call.resolve(JSObject().apply {
                        put("socksPort", config.torDefaultSocksPort)
                        put("proxyPort", config.reverseProxyDefaultPort)
                        put("mode", modeStr)
                    })
                } else {
                    call.reject("Tor bootstrap timeout after ${timeout / 1000}s")
                }
            } catch (e: Exception) {
                call.reject("Failed to start Tor: ${e.message}", e)
            }
        }.start()
    }

    @PluginMethod
    fun stopDaemon(call: PluginCall) {
        torManager.stopTor()
        call.resolve()
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("progress", torManager.currentBootstrap)
            put("isReady", torManager.isReady)
            put("state", torManager.currentState.name)
        })
    }

    @PluginMethod
    fun configure(call: PluginCall) {
        val modeStr = call.getString("mode") ?: "always"
        val bridgeStr = call.getString("bridgeType") ?: "NONE"
        val bridges = call.getArray("bridges")
            ?.toList<String>() ?: emptyList()

        val mode = when (modeStr.lowercase()) {
            "never", "neveruse" -> TorMode.NEVER
            "auto" -> TorMode.AUTO
            else -> TorMode.ALWAYS
        }
        val bridgeType = try {
            BridgeType.valueOf(bridgeStr.uppercase())
        } catch (_: Exception) {
            BridgeType.NONE
        }

        // Restart with new config
        Thread {
            torManager.restartTor(mode, bridgeType, bridges)
            call.resolve()
        }.start()
    }
}
```

**Step 2: Register plugin in MainActivity**

Read `android/app/src/main/java/com/bastyon/chat/MainActivity.kt` and add plugin registration. The file should look like:

```kotlin
package com.bastyon.chat

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.bastyon.chat.plugins.tor.TorPlugin

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(TorPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
```

**Step 3: Verify compilation**

```bash
cd android && ./gradlew compileDebugKotlin 2>&1 | tail -5
```

**Step 4: Commit**

```bash
git add android/app/src/main/java/com/bastyon/chat/plugins/tor/TorPlugin.kt \
        android/app/src/main/java/com/bastyon/chat/MainActivity.kt
git commit -m "feat(tor): add Capacitor TorPlugin bridge with start/stop/configure"
```

---

### Task 8: Create JS-side Tor service

**Files:**
- Create: `src/shared/lib/tor/tor-service.ts`
- Create: `src/shared/lib/tor/index.ts`

**Step 1: Create tor-service.ts**

```typescript
import { ref, readonly } from 'vue';
import { registerPlugin } from '@capacitor/core';
import { isNative } from '@/shared/lib/platform';

interface TorNativePlugin {
  startDaemon(options?: {
    mode?: 'always' | 'auto' | 'never';
    bridgeType?: string;
    bridges?: string[];
  }): Promise<{ socksPort: number; proxyPort: number; mode: string }>;
  stopDaemon(): Promise<void>;
  getStatus(): Promise<{ progress: number; isReady: boolean; state: string }>;
  configure(options: {
    mode: string;
    bridgeType?: string;
    bridges?: string[];
  }): Promise<void>;
  addListener(
    event: 'bootstrapProgress',
    cb: (data: { progress: number }) => void,
  ): Promise<{ remove: () => void }>;
  addListener(
    event: 'stateChanged',
    cb: (data: { state: string }) => void,
  ): Promise<{ remove: () => void }>;
}

const TorNative = registerPlugin<TorNativePlugin>('Tor');

class TorService {
  private _ready = ref(false);
  private _progress = ref(0);
  private _state = ref<string>('STOPPED');
  private _proxyPort = ref(0);

  readonly isReady = readonly(this._ready);
  readonly progress = readonly(this._progress);
  readonly state = readonly(this._state);

  /** Base URL for Matrix SDK when Tor is active. Empty string = use default. */
  get matrixBaseUrl(): string {
    if (!isNative || !this._ready.value || this._proxyPort.value === 0) {
      return ''; // Use default baseUrl
    }
    return `http://127.0.0.1:${this._proxyPort.value}`;
  }

  async init(mode: 'always' | 'auto' | 'never' = 'always'): Promise<void> {
    if (!isNative) {
      // On web/electron, Tor is managed separately
      this._ready.value = true;
      return;
    }

    await TorNative.addListener('bootstrapProgress', ({ progress }) => {
      this._progress.value = progress;
    });

    await TorNative.addListener('stateChanged', ({ state }) => {
      this._state.value = state;
      this._ready.value = state === 'RUNNING';
    });

    if (mode === 'never') {
      this._ready.value = true;
      return;
    }

    const result = await TorNative.startDaemon({ mode });
    this._proxyPort.value = result.proxyPort;
    this._ready.value = true;
  }

  async stop(): Promise<void> {
    if (!isNative) return;
    await TorNative.stopDaemon();
    this._ready.value = false;
    this._proxyPort.value = 0;
  }

  async reconfigure(options: {
    mode: string;
    bridgeType?: string;
    bridges?: string[];
  }): Promise<void> {
    if (!isNative) return;
    await TorNative.configure(options);
  }
}

export const torService = new TorService();
```

**Step 2: Create index.ts**

```typescript
export { torService } from './tor-service';
```

**Step 3: Verify TypeScript**

```bash
npx vue-tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/shared/lib/tor/
git commit -m "feat(tor): add JS-side TorService with reactive bootstrap state"
```

---

### Task 9: Integrate Tor proxy with Matrix SDK

**Files:**
- Modify: `src/entities/matrix/model/matrix-client.ts` (baseUrl switching)
- Modify: `src/app/providers/index.ts` (init sequence)

**Step 1: Modify matrix-client.ts to accept dynamic baseUrl**

In `src/entities/matrix/model/matrix-client.ts`, find the constructor and add a method to override baseUrl:

```typescript
// Add near top of class:
private torProxyUrl: string = '';

setTorProxyUrl(url: string) {
  this.torProxyUrl = url;
}

// Modify the getClient() or wherever baseUrl is used in request():
// Replace: this.baseUrl
// With: this.torProxyUrl || this.baseUrl
```

The key change: in the `request()` method (axios wrapper), prepend `torProxyUrl` when it's set. The reverse proxy on :8181 will forward to the actual Matrix server through Tor.

**Important**: The reverse proxy needs to know the real target host. The request URL should be the full original URL (e.g., `https://matrix.bastyon.com/...`), and the reverse proxy routes it through SOCKS5. Check how pocketnet's libreverseproxy works — it likely acts as a forward proxy, not reverse. If so, `axios` should set `proxy: { host: '127.0.0.1', port: 8181 }` instead of changing baseUrl.

Research pocketnet's `transports.js` for exact configuration:
- Lines 709-720: `getTorAgent()` creates `SocksProxyAgent('socks5h://127.0.0.1:9250')`
- Lines 68-99: Agent is set on axios as `httpAgent`/`httpsAgent`

**For Capacitor WebView**: axios in browser cannot use `httpAgent`. Instead, configure the proxy at the HTTP level. Two options:
- A) Change baseUrl to `http://127.0.0.1:8181` and have reverse proxy forward based on Host header
- B) Use `@capacitor/http` which runs on native side and can use SOCKS proxy

**Decision: Option A** (matches design doc). The reverse proxy (libreverseproxy.so) is an HTTP forward proxy — send requests to it with the real URL, it routes through Tor SOCKS.

Actual change needed in `request()` method:
```typescript
// In the axios call, when Tor is active, set proxy config:
const axiosOpts: any = { /* existing opts */ };

if (this.torProxyUrl) {
  // Route through local reverse proxy
  axiosOpts.proxy = {
    host: '127.0.0.1',
    port: 8181,
    protocol: 'http'
  };
}
```

**Step 2: Wire up in providers**

In `src/app/providers/index.ts`, in the `isNative` block:

```typescript
if (isNative) {
  const { torService } = await import('@/shared/lib/tor');
  await torService.init('always'); // or read from settings

  // Tell Matrix client to route through Tor proxy
  if (torService.matrixBaseUrl) {
    matrixService.setTorProxyUrl(torService.matrixBaseUrl);
  }
}
```

**Step 3: Verify TypeScript**

```bash
npx vue-tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/entities/matrix/model/matrix-client.ts src/app/providers/index.ts
git commit -m "feat(tor): integrate Tor reverse proxy with Matrix SDK requests"
```

---

## Phase 3: Push Notifications

### Task 10: Install push notification plugins

**Step 1: Install**

```bash
npm install @capacitor/push-notifications @capacitor/local-notifications
npx cap sync android
```

**Step 2: Add Firebase config**

Copy `google-services.json` from Firebase Console to `android/app/google-services.json`.

Add to `android/app/build.gradle`:
```groovy
apply plugin: 'com.google.gms.google-services'
```

Add to `android/build.gradle` (project-level) `buildscript.dependencies`:
```groovy
classpath 'com.google.gms:google-services:4.4.2'
```

**Step 3: Commit**

```bash
git add android/ package.json package-lock.json
git commit -m "feat(push): add Capacitor push and local notification plugins"
```

---

### Task 11: Create push service (JS side)

**Files:**
- Create: `src/shared/lib/push/push-service.ts`
- Create: `src/shared/lib/push/index.ts`

**Step 1: Create push-service.ts**

```typescript
import { PushNotifications } from '@capacitor/push-notifications';
import { LocalNotifications } from '@capacitor/local-notifications';
import { isNative } from '@/shared/lib/platform';

type MatrixClient = any; // Imported from matrix service when wired

class PushService {
  private fcmToken: string | null = null;
  private onCallPush: ((data: { callId: string; callerName: string; roomId: string; hasVideo: boolean }) => void) | null = null;
  private fetchAndDecrypt: ((roomId: string, eventId: string) => Promise<{ senderName: string; body: string } | null>) | null = null;

  /**
   * Set the callback for incoming call pushes.
   * Called before init() by the call bridge.
   */
  setCallHandler(handler: typeof this.onCallPush) {
    this.onCallPush = handler;
  }

  /**
   * Set the function to fetch and decrypt a Matrix event.
   * Called before init() by the chat store or matrix service.
   */
  setDecryptHandler(handler: typeof this.fetchAndDecrypt) {
    this.fetchAndDecrypt = handler;
  }

  async init(matrixClient: MatrixClient): Promise<void> {
    if (!isNative) return;

    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== 'granted') {
      console.warn('[PushService] Push permission denied');
      return;
    }

    // Request local notification permission (Android 13+)
    await LocalNotifications.requestPermissions();

    // Create notification channel (Android)
    await LocalNotifications.createChannel({
      id: 'messages',
      name: 'Messages',
      description: 'Chat message notifications',
      importance: 4, // HIGH
      sound: 'default',
      vibration: true,
    });

    await LocalNotifications.createChannel({
      id: 'calls',
      name: 'Calls',
      description: 'Incoming call notifications',
      importance: 5, // MAX
      sound: 'ringtone',
      vibration: true,
    });

    // Register for push
    await PushNotifications.register();

    // Handle token
    PushNotifications.addListener('registration', async ({ value: token }) => {
      console.log('[PushService] FCM token:', token.substring(0, 20) + '...');
      this.fcmToken = token;

      // Register pusher with Matrix server
      try {
        await matrixClient.setPusher({
          pushkey: token,
          kind: 'http',
          app_id: 'com.bastyon.chat',
          app_display_name: 'Bastyon Chat',
          device_display_name: 'Android',
          lang: 'en',
          data: {
            url: 'https://push.bastyon.com/_matrix/push/v1/notify',
            format: 'event_id_only',
          },
        });
        console.log('[PushService] Matrix pusher registered');
      } catch (e) {
        console.error('[PushService] Failed to register pusher:', e);
      }
    });

    PushNotifications.addListener('registrationError', (error) => {
      console.error('[PushService] Registration error:', error);
    });

    // Handle incoming data push
    PushNotifications.addListener('pushNotificationReceived', async (notification) => {
      const data = notification.data || {};

      // Call push
      if (data.type === 'call') {
        this.onCallPush?.({
          callId: data.call_id || data.event_id,
          callerName: data.caller_name || 'Unknown',
          roomId: data.room_id,
          hasVideo: data.has_video === 'true',
        });
        return;
      }

      // Message push — fetch, decrypt, show local notification
      const { event_id, room_id } = data;
      if (!event_id || !room_id) return;

      try {
        const decrypted = await this.fetchAndDecrypt?.(room_id, event_id);
        if (!decrypted) return;

        await LocalNotifications.schedule({
          notifications: [{
            id: Math.abs(hashString(event_id)),
            title: decrypted.senderName,
            body: decrypted.body,
            channelId: 'messages',
            extra: { room_id, event_id },
          }],
        });
      } catch (e) {
        console.error('[PushService] Failed to process push:', e);
      }
    });

    // Handle notification tap → navigate to room
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const { room_id } = action.notification.data || {};
      if (room_id) {
        // Navigate to room — will be wired to router
        window.dispatchEvent(new CustomEvent('push:openRoom', { detail: { roomId: room_id } }));
      }
    });

    // Same for local notifications
    LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
      const { room_id } = action.notification.extra || {};
      if (room_id) {
        window.dispatchEvent(new CustomEvent('push:openRoom', { detail: { roomId: room_id } }));
      }
    });
  }
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

export const pushService = new PushService();
```

**Step 2: Create index.ts**

```typescript
export { pushService } from './push-service';
```

**Step 3: Verify TypeScript**

```bash
npx vue-tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/shared/lib/push/
git commit -m "feat(push): add PushService with FCM data-only and local notifications"
```

---

## Phase 4: Native Calls (ConnectionService)

### Task 12: Create Android CallConnectionService

**Files:**
- Create: `android/app/src/main/java/com/bastyon/chat/plugins/calls/CallConnectionService.kt`
- Create: `android/app/src/main/java/com/bastyon/chat/plugins/calls/IncomingCallActivity.kt`

**Step 1: Create CallConnectionService.kt**

```kotlin
package com.bastyon.chat.plugins.calls

import android.content.ComponentName
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.telecom.*
import android.util.Log

class CallConnectionService : ConnectionService() {

    companion object {
        private const val TAG = "CallConnectionService"
        var currentConnection: CallConnection? = null

        fun getPhoneAccountHandle(context: Context): PhoneAccountHandle {
            val componentName = ComponentName(context, CallConnectionService::class.java)
            return PhoneAccountHandle(componentName, "BastyonChat")
        }

        fun registerPhoneAccount(context: Context) {
            val handle = getPhoneAccountHandle(context)
            val account = PhoneAccount.builder(handle, "Bastyon Chat")
                .setCapabilities(PhoneAccount.CAPABILITY_CALL_PROVIDER)
                .build()
            val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
            telecomManager.registerPhoneAccount(account)
        }
    }

    override fun onCreateIncomingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ): Connection {
        val extras = request?.extras ?: Bundle()
        val callId = extras.getString("callId", "")
        val callerName = extras.getString("callerName", "Unknown")

        Log.d(TAG, "onCreateIncomingConnection: callId=$callId, caller=$callerName")

        val connection = CallConnection(applicationContext, callId)
        connection.setCallerDisplayName(callerName, TelecomManager.PRESENTATION_ALLOWED)
        connection.setAddress(
            Uri.fromParts("tel", callerName, null),
            TelecomManager.PRESENTATION_ALLOWED
        )
        connection.setInitializing()
        connection.setRinging()
        connection.setActive()

        currentConnection = connection
        return connection
    }

    override fun onCreateIncomingConnectionFailed(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ) {
        Log.e(TAG, "onCreateIncomingConnectionFailed")
    }
}

class CallConnection(
    private val context: Context,
    val callId: String
) : Connection() {

    companion object {
        var onAnswered: ((String) -> Unit)? = null
        var onRejected: ((String) -> Unit)? = null
        var onEnded: ((String) -> Unit)? = null
    }

    override fun onAnswer() {
        Log.d("CallConnection", "onAnswer: $callId")
        setActive()
        onAnswered?.invoke(callId)
    }

    override fun onReject() {
        Log.d("CallConnection", "onReject: $callId")
        setDisconnected(DisconnectCause(DisconnectCause.REJECTED))
        destroy()
        onRejected?.invoke(callId)
    }

    override fun onDisconnect() {
        Log.d("CallConnection", "onDisconnect: $callId")
        setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
        destroy()
        onEnded?.invoke(callId)
    }
}
```

**Step 2: Create IncomingCallActivity.kt**

```kotlin
package com.bastyon.chat.plugins.calls

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import android.widget.LinearLayout
import android.view.Gravity

/**
 * Full-screen activity shown for incoming calls on lock screen.
 * Uses FLAG_SHOW_WHEN_LOCKED to appear over lock screen.
 */
class IncomingCallActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Show over lock screen
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
            keyguardManager.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
            )
        }

        val callerName = intent.getStringExtra("callerName") ?: "Unknown"
        val callId = intent.getStringExtra("callId") ?: ""

        // Simple programmatic UI (replace with XML layout later)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
        }

        val nameText = TextView(this).apply {
            text = callerName
            textSize = 28f
            gravity = Gravity.CENTER
        }

        val statusText = TextView(this).apply {
            text = "Incoming call..."
            textSize = 16f
            gravity = Gravity.CENTER
        }

        val acceptBtn = Button(this).apply {
            text = "Accept"
            setOnClickListener {
                CallConnectionService.currentConnection?.onAnswer()
                finish()
            }
        }

        val declineBtn = Button(this).apply {
            text = "Decline"
            setOnClickListener {
                CallConnectionService.currentConnection?.onReject()
                finish()
            }
        }

        val buttonRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            addView(declineBtn)
            addView(acceptBtn)
        }

        layout.addView(nameText)
        layout.addView(statusText)
        layout.addView(buttonRow)
        setContentView(layout)
    }
}
```

**Step 3: Add to AndroidManifest.xml**

In `android/app/src/main/AndroidManifest.xml`, inside `<application>`:

```xml
<service
    android:name="com.bastyon.chat.plugins.calls.CallConnectionService"
    android:permission="android.permission.BIND_TELECOM_CONNECTION_SERVICE"
    android:exported="true">
    <intent-filter>
        <action android:name="android.telecom.ConnectionService" />
    </intent-filter>
</service>

<activity
    android:name="com.bastyon.chat.plugins.calls.IncomingCallActivity"
    android:showOnLockScreen="true"
    android:turnScreenOn="true"
    android:exported="false"
    android:launchMode="singleTop"
    android:theme="@android:style/Theme.DeviceDefault.Light.NoActionBar" />
```

Add permissions:
```xml
<uses-permission android:name="android.permission.MANAGE_OWN_CALLS" />
<uses-permission android:name="android.permission.USE_FULL_SCREEN_INTENT" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
```

**Step 4: Verify compilation**

```bash
cd android && ./gradlew compileDebugKotlin 2>&1 | tail -5
```

**Step 5: Commit**

```bash
git add android/app/src/main/java/com/bastyon/chat/plugins/calls/ \
        android/app/src/main/AndroidManifest.xml
git commit -m "feat(calls): add ConnectionService and IncomingCallActivity for native calls"
```

---

### Task 13: Create Capacitor CallPlugin and JS bridge

**Files:**
- Create: `android/app/src/main/java/com/bastyon/chat/plugins/calls/CallPlugin.kt`
- Create: `src/shared/lib/native-calls/native-call-bridge.ts`
- Create: `src/shared/lib/native-calls/index.ts`
- Modify: `android/app/src/main/java/com/bastyon/chat/MainActivity.kt` (register plugin)

**Step 1: Create CallPlugin.kt**

```kotlin
package com.bastyon.chat.plugins.calls

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.telecom.TelecomManager
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "NativeCall")
class CallPlugin : Plugin() {

    companion object {
        private const val TAG = "CallPlugin"
    }

    override fun load() {
        // Register phone account for ConnectionService
        CallConnectionService.registerPhoneAccount(context)

        // Wire callbacks from native → JS
        CallConnection.onAnswered = { callId ->
            notifyListeners("callAnswered", JSObject().apply {
                put("callId", callId)
            })
        }
        CallConnection.onRejected = { callId ->
            notifyListeners("callDeclined", JSObject().apply {
                put("callId", callId)
            })
        }
        CallConnection.onEnded = { callId ->
            notifyListeners("callEnded", JSObject().apply {
                put("callId", callId)
            })
        }
    }

    @PluginMethod
    fun reportIncomingCall(call: PluginCall) {
        val callId = call.getString("callId") ?: ""
        val callerName = call.getString("callerName") ?: "Unknown"
        val roomId = call.getString("roomId") ?: ""
        val hasVideo = call.getBoolean("hasVideo", false) ?: false

        Log.d(TAG, "reportIncomingCall: $callerName ($callId)")

        try {
            val telecomManager = context.getSystemService(TelecomManager::class.java)
            val handle = CallConnectionService.getPhoneAccountHandle(context)

            val extras = Bundle().apply {
                putString("callId", callId)
                putString("callerName", callerName)
                putString("roomId", roomId)
                putBoolean("hasVideo", hasVideo)
                putParcelable(
                    TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE,
                    handle
                )
            }

            telecomManager.addNewIncomingCall(handle, extras)
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to report incoming call", e)

            // Fallback: show IncomingCallActivity directly
            val intent = Intent(context, IncomingCallActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
                putExtra("callId", callId)
                putExtra("callerName", callerName)
            }
            context.startActivity(intent)
            call.resolve()
        }
    }

    @PluginMethod
    fun reportCallEnded(call: PluginCall) {
        CallConnectionService.currentConnection?.onDisconnect()
        CallConnectionService.currentConnection = null
        call.resolve()
    }
}
```

**Step 2: Register in MainActivity**

Add to `MainActivity.kt`:
```kotlin
import com.bastyon.chat.plugins.calls.CallPlugin

// In onCreate(), before super.onCreate():
registerPlugin(CallPlugin::class.java)
```

**Step 3: Create native-call-bridge.ts**

```typescript
import { registerPlugin } from '@capacitor/core';
import { isNative } from '@/shared/lib/platform';

interface NativeCallNativePlugin {
  reportIncomingCall(options: {
    callId: string;
    callerName: string;
    roomId: string;
    hasVideo: boolean;
  }): Promise<void>;
  reportCallEnded(options: { callId: string }): Promise<void>;
  addListener(event: 'callAnswered', cb: (data: { callId: string }) => void): Promise<{ remove: () => void }>;
  addListener(event: 'callDeclined', cb: (data: { callId: string }) => void): Promise<{ remove: () => void }>;
  addListener(event: 'callEnded', cb: (data: { callId: string }) => void): Promise<{ remove: () => void }>;
}

const NativeCall = registerPlugin<NativeCallNativePlugin>('NativeCall');

/**
 * Bridge between native call UI (ConnectionService) and
 * the existing call-service.ts WebRTC logic.
 */
class NativeCallBridge {
  private callService: any = null; // Set via wire()

  /**
   * Wire this bridge to the existing call-service.
   * Call once during app init.
   */
  async wire(callService: { answerCall: () => void; rejectCall: () => void }): Promise<void> {
    if (!isNative) return;
    this.callService = callService;

    await NativeCall.addListener('callAnswered', ({ callId }) => {
      console.log('[NativeCallBridge] Call answered:', callId);
      this.callService?.answerCall();
    });

    await NativeCall.addListener('callDeclined', ({ callId }) => {
      console.log('[NativeCallBridge] Call declined:', callId);
      this.callService?.rejectCall();
    });

    await NativeCall.addListener('callEnded', ({ callId }) => {
      console.log('[NativeCallBridge] Call ended natively:', callId);
    });
  }

  /**
   * Show native incoming call UI.
   * Called by push-service when a call push arrives.
   */
  async reportIncomingCall(options: {
    callId: string;
    callerName: string;
    roomId: string;
    hasVideo: boolean;
  }): Promise<void> {
    if (!isNative) return;
    await NativeCall.reportIncomingCall(options);
  }

  /**
   * Tell native side the call has ended.
   * Called by call-service when WebRTC call ends.
   */
  async reportCallEnded(callId: string): Promise<void> {
    if (!isNative) return;
    await NativeCall.reportCallEnded({ callId });
  }
}

export const nativeCallBridge = new NativeCallBridge();
```

**Step 4: Create index.ts**

```typescript
export { nativeCallBridge } from './native-call-bridge';
```

**Step 5: Verify TypeScript**

```bash
npx vue-tsc --noEmit
```

**Step 6: Commit**

```bash
git add android/app/src/main/java/com/bastyon/chat/plugins/calls/CallPlugin.kt \
        android/app/src/main/java/com/bastyon/chat/MainActivity.kt \
        src/shared/lib/native-calls/
git commit -m "feat(calls): add Capacitor CallPlugin and JS NativeCallBridge"
```

---

## Phase 5: Streaming File Transfer via Tor

### Task 14: Create Android TorFilePlugin

**Files:**
- Create: `android/app/src/main/java/com/bastyon/chat/plugins/filetransfer/TorFilePlugin.kt`
- Modify: `android/app/src/main/java/com/bastyon/chat/MainActivity.kt` (register)

**Step 1: Create TorFilePlugin.kt**

```kotlin
package com.bastyon.chat.plugins.filetransfer

import android.net.Uri
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.*
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL

@CapacitorPlugin(name = "TorFile")
class TorFilePlugin : Plugin() {

    companion object {
        private const val TAG = "TorFilePlugin"
        private const val PROXY_PORT = 8181
        private const val BUFFER_SIZE = 8192
    }

    @PluginMethod
    fun upload(call: PluginCall) {
        val filePath = call.getString("filePath") ?: run {
            call.reject("filePath required"); return
        }
        val uploadUrl = call.getString("uploadUrl") ?: run {
            call.reject("uploadUrl required"); return
        }
        val mimeType = call.getString("mimeType") ?: "application/octet-stream"
        val authHeader = call.getString("authorization") ?: ""

        Thread {
            try {
                val uri = Uri.parse(filePath)
                val inputStream: InputStream = if (uri.scheme == "content" || uri.scheme == "file") {
                    context.contentResolver.openInputStream(uri)
                        ?: throw IOException("Cannot open: $filePath")
                } else {
                    FileInputStream(File(filePath))
                }

                val fileSize = inputStream.available().toLong()

                // Connect through local reverse proxy (HTTP forward proxy → Tor)
                val proxy = Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", PROXY_PORT))
                val url = URL(uploadUrl)
                val conn = url.openConnection(proxy) as HttpURLConnection

                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", mimeType)
                conn.setRequestProperty("Content-Length", fileSize.toString())
                if (authHeader.isNotEmpty()) {
                    conn.setRequestProperty("Authorization", authHeader)
                }
                conn.setChunkedStreamingMode(BUFFER_SIZE)

                val outputStream = conn.outputStream
                val buffer = ByteArray(BUFFER_SIZE)
                var uploaded = 0L
                var bytesRead: Int

                inputStream.use { input ->
                    outputStream.use { output ->
                        while (input.read(buffer).also { bytesRead = it } != -1) {
                            output.write(buffer, 0, bytesRead)
                            uploaded += bytesRead

                            if (fileSize > 0) {
                                val percent = (uploaded * 100 / fileSize).toInt()
                                notifyListeners("progress", JSObject().apply {
                                    put("percent", percent)
                                    put("loaded", uploaded)
                                    put("total", fileSize)
                                })
                            }
                        }
                    }
                }

                val responseCode = conn.responseCode
                if (responseCode in 200..299) {
                    val responseBody = conn.inputStream.bufferedReader().readText()
                    call.resolve(JSObject().apply {
                        put("contentUri", responseBody)
                        put("statusCode", responseCode)
                    })
                } else {
                    call.reject("Upload failed: HTTP $responseCode")
                }

                conn.disconnect()
            } catch (e: Exception) {
                Log.e(TAG, "Upload error", e)
                call.reject("Upload failed: ${e.message}", e)
            }
        }.start()
    }

    @PluginMethod
    fun download(call: PluginCall) {
        val url = call.getString("url") ?: run {
            call.reject("url required"); return
        }
        val authHeader = call.getString("authorization") ?: ""

        Thread {
            try {
                val proxy = Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", PROXY_PORT))
                val conn = URL(url).openConnection(proxy) as HttpURLConnection

                if (authHeader.isNotEmpty()) {
                    conn.setRequestProperty("Authorization", authHeader)
                }

                val responseCode = conn.responseCode
                if (responseCode !in 200..299) {
                    call.reject("Download failed: HTTP $responseCode")
                    return@Thread
                }

                val contentLength = conn.contentLengthLong
                val ext = guessMimeExtension(conn.contentType ?: "application/octet-stream")
                val outFile = File(context.cacheDir, "download_${System.currentTimeMillis()}$ext")

                conn.inputStream.use { input ->
                    outFile.outputStream().use { output ->
                        val buffer = ByteArray(BUFFER_SIZE)
                        var downloaded = 0L
                        var bytesRead: Int
                        while (input.read(buffer).also { bytesRead = it } != -1) {
                            output.write(buffer, 0, bytesRead)
                            downloaded += bytesRead
                            if (contentLength > 0) {
                                notifyListeners("progress", JSObject().apply {
                                    put("percent", (downloaded * 100 / contentLength).toInt())
                                    put("loaded", downloaded)
                                    put("total", contentLength)
                                })
                            }
                        }
                    }
                }

                conn.disconnect()

                call.resolve(JSObject().apply {
                    put("filePath", outFile.absolutePath)
                    put("mimeType", conn.contentType)
                    put("size", outFile.length())
                })
            } catch (e: Exception) {
                Log.e(TAG, "Download error", e)
                call.reject("Download failed: ${e.message}", e)
            }
        }.start()
    }

    private fun guessMimeExtension(mime: String): String = when {
        mime.contains("jpeg") || mime.contains("jpg") -> ".jpg"
        mime.contains("png") -> ".png"
        mime.contains("gif") -> ".gif"
        mime.contains("webp") -> ".webp"
        mime.contains("mp4") -> ".mp4"
        mime.contains("webm") -> ".webm"
        mime.contains("ogg") -> ".ogg"
        mime.contains("pdf") -> ".pdf"
        else -> ".bin"
    }
}
```

**Step 2: Register in MainActivity**

Add to `MainActivity.kt`:
```kotlin
import com.bastyon.chat.plugins.filetransfer.TorFilePlugin

// In onCreate(), before super.onCreate():
registerPlugin(TorFilePlugin::class.java)
```

**Step 3: Verify compilation**

```bash
cd android && ./gradlew compileDebugKotlin 2>&1 | tail -5
```

**Step 4: Commit**

```bash
git add android/app/src/main/java/com/bastyon/chat/plugins/filetransfer/ \
        android/app/src/main/java/com/bastyon/chat/MainActivity.kt
git commit -m "feat(files): add TorFilePlugin for streaming upload/download via Tor"
```

---

### Task 15: Create JS-side file transfer service

**Files:**
- Create: `src/shared/lib/file-transfer/file-transfer-service.ts`
- Create: `src/shared/lib/file-transfer/index.ts`

**Step 1: Create file-transfer-service.ts**

```typescript
import { registerPlugin } from '@capacitor/core';
import { isNative } from '@/shared/lib/platform';

interface TorFileNativePlugin {
  upload(options: {
    filePath: string;
    uploadUrl: string;
    mimeType: string;
    authorization?: string;
  }): Promise<{ contentUri: string; statusCode: number }>;
  download(options: {
    url: string;
    authorization?: string;
  }): Promise<{ filePath: string; mimeType: string; size: number }>;
  addListener(
    event: 'progress',
    cb: (data: { percent: number; loaded: number; total: number }) => void,
  ): Promise<{ remove: () => void }>;
}

const TorFile = registerPlugin<TorFileNativePlugin>('TorFile');

class FileTransferService {
  private progressListener: { remove: () => void } | null = null;

  /**
   * Upload a file via native streaming (bypasses WebView base64 limitation).
   * Falls back to standard fetch on web.
   */
  async upload(options: {
    filePath: string;
    uploadUrl: string;
    mimeType: string;
    authorization?: string;
    onProgress?: (percent: number) => void;
  }): Promise<string> {
    if (!isNative) {
      // Web fallback: use standard fetch (file already in memory)
      throw new Error('FileTransferService.upload() is native-only. Use fetch on web.');
    }

    // Listen to progress
    if (options.onProgress) {
      this.progressListener?.remove();
      this.progressListener = (await TorFile.addListener('progress', ({ percent }) => {
        options.onProgress!(percent);
      }));
    }

    try {
      const result = await TorFile.upload({
        filePath: options.filePath,
        uploadUrl: options.uploadUrl,
        mimeType: options.mimeType,
        authorization: options.authorization,
      });
      return result.contentUri;
    } finally {
      this.progressListener?.remove();
      this.progressListener = null;
    }
  }

  /**
   * Download a file via native streaming through Tor proxy.
   * Returns a local file:// path.
   */
  async download(options: {
    url: string;
    authorization?: string;
    onProgress?: (percent: number) => void;
  }): Promise<{ filePath: string; mimeType: string }> {
    if (!isNative) {
      throw new Error('FileTransferService.download() is native-only.');
    }

    if (options.onProgress) {
      this.progressListener?.remove();
      this.progressListener = (await TorFile.addListener('progress', ({ percent }) => {
        options.onProgress!(percent);
      }));
    }

    try {
      const result = await TorFile.download({
        url: options.url,
        authorization: options.authorization,
      });
      return { filePath: result.filePath, mimeType: result.mimeType };
    } finally {
      this.progressListener?.remove();
      this.progressListener = null;
    }
  }
}

export const fileTransferService = new FileTransferService();
```

**Step 2: Create index.ts**

```typescript
export { fileTransferService } from './file-transfer-service';
```

**Step 3: Verify TypeScript**

```bash
npx vue-tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/shared/lib/file-transfer/
git commit -m "feat(files): add JS FileTransferService for native streaming uploads"
```

---

## Phase 6: Wire Everything Together

### Task 16: Update app initialization for Capacitor

**Files:**
- Modify: `src/app/providers/index.ts`
- Modify: `src/entities/auth/model/stores.ts` (wire push after Matrix init)

**Step 1: Add Capacitor init to providers**

In `src/app/providers/index.ts`, add the native initialization block:

```typescript
import { isNative } from '@/shared/lib/platform';

// Inside setupProviders(), after the Electron block:
if (isNative) {
  // 1. Start Tor
  const { torService } = await import('@/shared/lib/tor');
  await torService.init('always');

  // 2. Wire native calls
  const { nativeCallBridge } = await import('@/shared/lib/native-calls');
  // callService will be wired after Matrix init (in auth store)

  // 3. Push init happens after Matrix login (in auth store's initMatrix)
}
```

**Step 2: Wire push and call bridge in auth store**

In `src/entities/auth/model/stores.ts`, inside `initMatrix()`, after `matrixService.init()`:

```typescript
import { isNative } from '@/shared/lib/platform';

// After matrixService.init() succeeds:
if (isNative) {
  const { pushService } = await import('@/shared/lib/push');
  const { nativeCallBridge } = await import('@/shared/lib/native-calls');

  // Wire call bridge to existing callService
  await nativeCallBridge.wire(callService);

  // Wire push service
  pushService.setCallHandler((data) => {
    nativeCallBridge.reportIncomingCall(data);
  });

  pushService.setDecryptHandler(async (roomId, eventId) => {
    // Use matrix client to fetch and decrypt the event
    const client = matrixService.getMatrixClient();
    if (!client) return null;
    const event = await client.fetchRoomEvent(roomId, eventId);
    // Decrypt if needed (SDK handles this if crypto is initialized)
    return {
      senderName: event.sender || 'Unknown',
      body: event.content?.body || 'New message',
    };
  });

  // Init push with matrix client
  const client = matrixService.getMatrixClient();
  if (client) {
    await pushService.init(client);
  }
}
```

**Step 3: Wire Tor proxy URL to Matrix client**

In the same `initMatrix()`, before `matrixService.init()`:

```typescript
if (isNative) {
  const { torService } = await import('@/shared/lib/tor');
  if (torService.matrixBaseUrl) {
    matrixService.setTorProxyUrl(torService.matrixBaseUrl);
  }
}
```

**Step 4: Verify TypeScript**

```bash
npx vue-tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/app/providers/index.ts src/entities/auth/model/stores.ts
git commit -m "feat: wire Tor, Push, and Call services into app initialization"
```

---

### Task 17: Add Capacitor camera and filesystem plugins

**Step 1: Install plugins**

```bash
npm install @capacitor/camera @capacitor/filesystem
npx cap sync android
```

**Step 2: Add permissions to AndroidManifest.xml**

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
```

**Step 3: Commit**

```bash
git add android/ package.json package-lock.json
git commit -m "feat(media): add camera and filesystem plugins with permissions"
```

---

### Task 18: Build and test on device

**Step 1: Full build cycle**

```bash
npm run build && npx cap sync android
```

**Step 2: Run on connected device**

```bash
npx cap run android
```

**Step 3: Verify checklist**

- [ ] App opens in WebView, Vue UI renders
- [ ] Tor bootstrap progress shows (check `adb logcat | grep Tor`)
- [ ] After Tor ready, Matrix login works
- [ ] Chat messages load through Tor proxy
- [ ] FCM token is registered (check `adb logcat | grep PushService`)
- [ ] Camera picker opens from attach button
- [ ] Incoming call push shows native UI (requires push gateway setup)

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete Capacitor Android app with Tor, Push, Calls, Media"
```

---

## Summary

| Phase | Tasks | What it delivers |
|-------|-------|-----------------|
| 1. Scaffold | 1-2 | Capacitor project + platform abstraction |
| 2. Tor | 3-9 | Full Tor integration with reverse proxy, matching Pocketnet |
| 3. Push | 10-11 | Privacy-preserving FCM + local notifications |
| 4. Calls | 12-13 | Native lock-screen incoming call UI |
| 5. Files | 14-15 | Streaming upload/download through Tor |
| 6. Wire | 16-18 | Everything connected, ready to test on device |

**Total: 18 tasks across 6 phases.**

Each phase can be tested independently. Phase 2 (Tor) is the largest and most critical — test thoroughly on a real Android device with `adb logcat`.
