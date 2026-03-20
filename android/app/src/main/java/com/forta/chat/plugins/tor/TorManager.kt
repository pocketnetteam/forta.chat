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
        lock.withLock {
            if (state.get() != TorState.STOPPED) {
                Log.w(TAG, "Tor already ${state.get()}, ignoring start")
                return
            }
            setState(TorState.STARTING)
            bootstrapPercent.set(0)
        }

        config.ensureGeoIPFiles()

        val torrc = config.generateTorrc(mode, bridgeType, customBridges)
        File(config.torConfPath).apply {
            parentFile?.mkdirs()
            writeText(torrc)
        }

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
                                bootstrapPercent.set(pct)
                                onBootstrapProgress?.invoke(pct)
                                if (pct >= 100) {
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
