package com.forta.chat.plugins.tor

import android.util.Log
import java.io.File
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

enum class TorState { STOPPED, STARTING, RUNNING, STOPPING }

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
        val bootStart = android.os.SystemClock.elapsedRealtime()
        fun elapsed() = android.os.SystemClock.elapsedRealtime() - bootStart

        lock.withLock {
            if (state.get() != TorState.STOPPED) {
                Log.w(TAG, "Tor already ${state.get()}, ignoring start")
                return
            }
            setState(TorState.STARTING)
            bootstrapPercent.set(0)
        }

        config.ensureGeoIPFiles()
        Log.i(TAG, "[BOOT] T+${elapsed()}ms geoip files ready")

        // Pre-check: remove stale lock file from previous crash
        val lockFile = java.io.File(config.torDataDir, "lock")
        if (lockFile.exists()) {
            Log.w(TAG, "[BOOT] Removing stale Tor lock file")
            lockFile.delete()
        }

        // Pre-check: verify SOCKS port is free
        try {
            val socket = java.net.Socket()
            socket.connect(java.net.InetSocketAddress("127.0.0.1", config.torDefaultSocksPort), 500)
            socket.close()
            Log.w(TAG, "[BOOT] SOCKS port ${config.torDefaultSocksPort} in use — killing stale process")
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

        val torrc = config.generateTorrc(mode, bridgeType, customBridges)
        File(config.torConfPath).apply {
            parentFile?.mkdirs()
            writeText(torrc)
        }
        Log.i(TAG, "[BOOT] T+${elapsed()}ms torrc written")

        File(config.torPath).setExecutable(true)

        torThread = Thread({
            try {
                val exitCode = torRunner.start(
                    binaryPath = config.torPath,
                    args = listOf("-f", config.torConfPath, "--pidfile", config.torPidPath),
                    env = mapOf("LD_LIBRARY_PATH" to config.nativeLibPath),
                    listener = object : ProcessRunner.OutputListener {
                        override fun onStdOutput(line: String) {
                            val pct = ProcessRunner.parseBootstrapPercent(line)
                            if (pct != null) {
                                Log.i(TAG, "[BOOT] T+${elapsed()}ms Bootstrap $pct%")
                                bootstrapPercent.set(pct)
                                onBootstrapProgress?.invoke(pct)
                                if (pct >= 100) {
                                    Log.i(TAG, "[BOOT] T+${elapsed()}ms Tor ready, starting reverse proxy")
                                    startReverseProxy()
                                    setState(TorState.RUNNING)
                                }
                            }
                        }
                        override fun onErrOutput(line: String) {}
                    }
                )
                Log.d(TAG, "Tor process exited with code $exitCode")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start Tor process", e)
            }
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
