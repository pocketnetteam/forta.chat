package com.forta.chat.plugins.tor

import android.content.Context

data class TorPersistedSettings(
    val mode: TorMode,
    val bridgeType: BridgeType,
)

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

    private val prefs
        get() = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun loadSettings(): TorPersistedSettings {
        val modeStr = prefs.getString(PREF_MODE, TorMode.NEVER.name) ?: TorMode.NEVER.name
        val bridgeStr = prefs.getString(PREF_BRIDGE, BridgeType.NONE.name) ?: BridgeType.NONE.name
        val mode = try {
            TorMode.valueOf(modeStr)
        } catch (_: Exception) {
            TorMode.NEVER
        }
        val bridgeType = try {
            BridgeType.valueOf(bridgeStr)
        } catch (_: Exception) {
            BridgeType.NONE
        }
        return TorPersistedSettings(mode, bridgeType)
    }

    fun saveSettings(mode: TorMode, bridgeType: BridgeType) {
        prefs.edit()
            .putString(PREF_MODE, mode.name)
            .putString(PREF_BRIDGE, bridgeType.name)
            .apply()
    }

    fun ensureGeoIPFiles() {
        val dir = java.io.File(torConfDir)
        if (!dir.exists()) dir.mkdirs()

        val dataDir = java.io.File(torDataDir)
        if (!dataDir.exists()) dataDir.mkdirs()

        // Re-copy if a previous Windows checkout left CRLF in place.
        normalizeGeoIpIfNeeded(geoipPath, "tor/geoip")
        normalizeGeoIpIfNeeded(geoip6Path, "tor/geoip6")
    }

    private fun normalizeGeoIpIfNeeded(destPath: String, assetName: String) {
        val dest = java.io.File(destPath)
        if (dest.exists()) {
            val sample = dest.inputStream().use { input ->
                val buf = ByteArray(4096)
                val n = input.read(buf)
                if (n <= 0) ByteArray(0) else buf.copyOf(n)
            }
            if (!sample.contains('\r'.code.toByte())) return
            dest.delete()
        }
        copyAssetIfMissing(assetName, destPath)
    }

    private fun copyAssetIfMissing(assetName: String, destPath: String) {
        val dest = java.io.File(destPath)
        if (dest.exists()) return
        context.assets.open(assetName).use { input ->
            // GeoIP dumps must be LF-only; CRLF from Windows checkouts breaks Tor's parser.
            val text = input.bufferedReader().readText().replace("\r\n", "\n").replace("\r", "\n")
            dest.writeText(text)
        }
    }

    fun generateTorrc(
        mode: TorMode = TorMode.ALWAYS,
        bridgeType: BridgeType = BridgeType.NONE,
        customBridges: List<String> = emptyList()
    ): String {
        // Quote paths — Torrc treats unquoted spaces as argument separators.
        fun q(p: String) = "\"$p\""

        val sb = StringBuilder()
        sb.appendLine("SocksPort $torDefaultSocksPort")
        sb.appendLine("ControlPort $torControlPort")
        sb.appendLine("CookieAuthentication 1")
        sb.appendLine("DormantCanceledByStartup 1")
        sb.appendLine("DataDirectory ${q(torDataDir)}")
        sb.appendLine("GeoIPFile ${q(geoipPath)}")
        sb.appendLine("GeoIPv6File ${q(geoip6Path)}")
        sb.appendLine("AvoidDiskWrites 1")
        sb.appendLine("KeepalivePeriod 10")
        sb.appendLine("Log notice stdout")

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
                // PT path must stay unquoted (Tor ClientTransportPlugin quirk).
                sb.appendLine("ClientTransportPlugin snowflake exec $snowflakePath")
                // Tor Browser / Orbot-style CDN77 fronts (AMP/Google fronts often
                // blocked in RU). Keep two bridge lines for redundancy.
                val ice = listOf(
                    "stun:stun.antisip.com:3478",
                    "stun:stun.epygi.com:3478",
                    "stun:stun.uls.co.za:3478",
                    "stun:stun.voipgate.com:3478",
                    "stun:stun.mixvoip.com:3478",
                    "stun:stun.nextcloud.com:443",
                    "stun:stun.sonetel.net:3478",
                    "stun:stun.voipia.net:3478",
                    "stun:stun.voys.nl:3478",
                ).joinToString(",")
                val fronts = "www.phpmyadmin.net,cdn.zk.mk"
                val broker = "https://1098762253.rsc.cdn77.org/"
                sb.appendLine(
                    "Bridge snowflake 192.0.2.4:80 8838024498816A039FCBBAB14E6F40A0843051FA " +
                        "fingerprint=8838024498816A039FCBBAB14E6F40A0843051FA " +
                        "url=$broker fronts=$fronts ice=$ice " +
                        "utls-imitate=hellorandomizedalpn",
                )
                sb.appendLine(
                    "Bridge snowflake 192.0.2.3:80 2B280B23E1107BB62ABFC40DDCC8824814F80A72 " +
                        "fingerprint=2B280B23E1107BB62ABFC40DDCC8824814F80A72 " +
                        "url=$broker fronts=$fronts ice=$ice " +
                        "utls-imitate=hellorandomizedalpn",
                )
            }
            else -> {}
        }

        return sb.toString()
    }

    companion object {
        private const val PREFS_NAME = "tor_settings"
        private const val PREF_MODE = "mode"
        private const val PREF_BRIDGE = "bridgeType"
    }
}

enum class TorMode { NEVER, AUTO, ALWAYS }
enum class BridgeType { NONE, VANILLA, OBFS4, SNOWFLAKE, WEBTUNNEL }
