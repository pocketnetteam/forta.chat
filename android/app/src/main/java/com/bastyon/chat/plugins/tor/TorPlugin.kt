package com.bastyon.chat.plugins.tor

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

        Thread {
            torManager.restartTor(mode, bridgeType, bridges)
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
}
