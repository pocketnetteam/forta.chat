package com.forta.chat.plugins.tor

import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL

@CapacitorPlugin(name = "Tor")
class TorPlugin : Plugin() {

    private lateinit var config: ConfigurationManager
    private lateinit var torManager: TorManager
    private val routeDecider = TorRouteDecider()

    override fun load() {
        config = ConfigurationManager(context)
        torManager = TorManager(config)
        Log.i("TorPlugin", "loaded mode=${torManager.mode} bridge=${torManager.bridgeType}")

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
        // Prefer explicit bridgeType; otherwise keep persisted preference.
        // Defaulting to NONE here previously wiped Snowflake on every boot
        // (JS initBackground only passed mode) and left bootstrap stuck at ~10%.
        val bridgeStr = call.getString("bridgeType") ?: torManager.bridgeType.name
        Log.i("TorPlugin", "startDaemon mode=$modeStr bridge=$bridgeStr")
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
            torManager.bridgeType
        }

        if (mode == TorMode.NEVER) {
            torManager.persistSettings(TorMode.NEVER, bridgeType)
            torManager.stopTor()
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
        val bridgeStr = call.getString("bridgeType") ?: torManager.bridgeType.name
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
            torManager.bridgeType
        }

        Thread {
            if (mode == TorMode.NEVER) {
                torManager.persistSettings(TorMode.NEVER, bridgeType)
                torManager.stopTor()
            } else {
                torManager.restartTor(mode, bridgeType, bridges)
            }
            call.resolve()
        }.start()
    }

    @PluginMethod
    fun verifyTor(call: PluginCall) {
        if (!torManager.isReady) {
            call.resolve(JSObject().apply {
                put("isTor", false)
                put("ip", "")
                put("error", "Tor not ready")
            })
            return
        }

        Thread {
            val proxy = Proxy(
                Proxy.Type.SOCKS,
                InetSocketAddress("127.0.0.1", config.torDefaultSocksPort)
            )

            // Step 1: check.torproject.org
            try {
                val url = URL("https://check.torproject.org/api/ip")
                val conn = url.openConnection(proxy) as HttpURLConnection
                conn.connectTimeout = 15000
                conn.readTimeout = 15000
                conn.requestMethod = "GET"

                if (conn.responseCode == 200) {
                    val body = conn.inputStream.bufferedReader().readText()
                    conn.disconnect()
                    val json = org.json.JSONObject(body)
                    call.resolve(JSObject().apply {
                        put("isTor", json.optBoolean("IsTor", false))
                        put("ip", json.optString("IP", ""))
                    })
                    return@Thread
                }
                conn.disconnect()
            } catch (e: Exception) {
                Log.d("TorPlugin", "torproject check failed, trying fallback: ${e.message}")
            }

            // Step 2: compare IPs
            try {
                val proxyUrl = URL("https://api.ipify.org?format=json")
                val proxyConn = proxyUrl.openConnection(proxy) as HttpURLConnection
                proxyConn.connectTimeout = 15000
                proxyConn.readTimeout = 15000
                val proxyBody = proxyConn.inputStream.bufferedReader().readText()
                proxyConn.disconnect()
                val proxyIp = org.json.JSONObject(proxyBody).optString("ip", "")

                val directConn = proxyUrl.openConnection() as HttpURLConnection
                directConn.connectTimeout = 10000
                directConn.readTimeout = 10000
                val directBody = directConn.inputStream.bufferedReader().readText()
                directConn.disconnect()
                val directIp = org.json.JSONObject(directBody).optString("ip", "")

                val isTor = proxyIp.isNotEmpty() && directIp.isNotEmpty() && proxyIp != directIp
                call.resolve(JSObject().apply {
                    put("isTor", isTor)
                    put("ip", proxyIp)
                })
            } catch (e: Exception) {
                Log.e("TorPlugin", "verify fallback failed", e)
                call.resolve(JSObject().apply {
                    put("isTor", false)
                    put("ip", "")
                    put("error", e.message ?: "verification failed")
                })
            }
        }.start()
    }

    @PluginMethod
    fun isUseWithTor(call: PluginCall) {
        val url = call.getString("url") ?: run {
            call.reject("url required")
            return
        }

        Thread {
            val redirect = routeDecider.isUseWithTor(
                url,
                torManager.mode,
                torManager.isReady,
            )
            call.resolve(JSObject().apply {
                put("redirect", redirect)
            })
        }.start()
    }

    @PluginMethod
    fun getSettings(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("mode", torModeToJs(torManager.mode))
            put("bridgeType", torManager.bridgeType.name)
            put("isReady", torManager.isReady)
        })
    }

    private fun torModeToJs(mode: TorMode): String = when (mode) {
        TorMode.NEVER -> "neveruse"
        TorMode.AUTO -> "auto"
        TorMode.ALWAYS -> "always"
    }

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
}
