package com.bastyon.chat.plugins.tor

import android.content.Context

class ConfigurationManager(private val context: Context) {

    val appDataDir: String
        get() = context.applicationInfo?.dataDir ?: context.filesDir.absolutePath

    val nativeLibPath: String
        get() = context.applicationInfo.nativeLibraryDir

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

    val reverseProxyPath: String get() = "$nativeLibPath/libreverseproxy.so"
    val reverseProxyPidPath: String get() = "$appDataDir/app_data/tor/rp.pid"
    val reverseProxyDefaultPort: Int = 8181

    val obfs4proxyPath: String get() = "$nativeLibPath/libobfs4proxy.so"
    val snowflakePath: String get() = "$nativeLibPath/libsnowflake.so"
    val conjurePath: String get() = "$nativeLibPath/libconjure.so"

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
