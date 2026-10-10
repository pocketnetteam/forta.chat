package com.forta.chat.plugins.push

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Missed push calls T3 (2026-10-10): the battery hint reads the exemption from
 * PowerManager and only opens the system dialog — the app never changes the
 * setting — and the manifest declares the permission the dialog needs.
 */
class BatteryOptimizationContractTest {

    private fun file(vararg candidates: String): String =
        candidates.map { File(it) }.firstOrNull { it.exists() }?.readText()
            ?: error("none of ${candidates.toList()} found from ${File(".").absolutePath}")

    private val plugin by lazy {
        file(
            "src/main/java/com/forta/chat/plugins/push/PushDataPlugin.kt",
            "android/app/src/main/java/com/forta/chat/plugins/push/PushDataPlugin.kt",
        )
    }

    private val manifest by lazy {
        file("src/main/AndroidManifest.xml", "android/app/src/main/AndroidManifest.xml")
    }

    private fun method(name: String): String {
        val start = plugin.indexOf("fun $name(")
        assertTrue("no $name in PushDataPlugin", start >= 0)
        val annotation = plugin.lastIndexOf("@PluginMethod", start)
        assertTrue("$name must be a @PluginMethod", annotation >= 0 && start - annotation < 40)
        val next = plugin.indexOf("\n    @", start).let { if (it < 0) plugin.length else it }
        return plugin.substring(start, next)
    }

    @Test
    fun statusComesFromPowerManager() {
        val body = method("getBatteryOptimizationStatus")
        assertTrue(body, body.contains("isIgnoringBatteryOptimizations(context.packageName)"))
        assertTrue(body, body.contains("put(\"ignoring\""))
    }

    @Test
    fun requestOpensTheSystemDialogForThisPackageWithAFallback() {
        val body = method("requestIgnoreBatteryOptimizations")
        assertTrue(body, body.contains("Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"))
        assertTrue(body, body.contains("Uri.parse(\"package:\${context.packageName}\")"))
        assertTrue(body, body.contains("Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS"))
    }

    @Test
    fun manifestDeclaresThePermission() {
        assertTrue(manifest.contains("android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"))
    }
}
