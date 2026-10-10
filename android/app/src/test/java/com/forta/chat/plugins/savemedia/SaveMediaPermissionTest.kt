package com.forta.chat.plugins.savemedia

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Audit S4-04: on Android 7-9 (API 24-28) the manifest entry alone is no
 * grant, so every save to the gallery threw SecurityException. save() now asks
 * for WRITE_EXTERNAL_STORAGE there first. The request itself needs a device;
 * the decision and the wiring are checked here.
 */
class SaveMediaPermissionTest {

    private val plugin by lazy {
        val relative = "com/forta/chat/plugins/savemedia/SaveMediaPlugin.kt"
        listOf("src/main/java/$relative", "android/app/src/main/java/$relative")
            .map { File(it) }.firstOrNull { it.exists() }?.readText() ?: error("$relative not found")
    }

    @Test
    fun onlyLegacyStorageNeedsTheRuntimeGrant() {
        assertTrue(SaveMediaPlugin.needsLegacyStoragePermission(24))
        assertTrue(SaveMediaPlugin.needsLegacyStoragePermission(28))
        assertFalse(SaveMediaPlugin.needsLegacyStoragePermission(29))
        assertFalse(SaveMediaPlugin.needsLegacyStoragePermission(35))
    }

    @Test
    fun saveAsksBeforeWritingAndReportsARefusal() {
        assertTrue(
            plugin.contains(
                "Permission(alias = SaveMediaPlugin.STORAGE_ALIAS, strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE])",
            ),
        )
        val save = plugin.substringAfter("fun save(call: PluginCall) {").substringBefore("@PermissionCallback")
        assertTrue(save.contains("requestPermissionForAlias(STORAGE_ALIAS, call, \"storagePermissionCallback\")"))
        assertTrue(save.indexOf("requestPermissionForAlias") < save.indexOf("saveGranted(call)"))
        val callback = plugin
            .substringAfter("private fun storagePermissionCallback(call: PluginCall) {")
            .substringBefore("private fun saveGranted")
        assertTrue(callback.contains("call.reject(PERMISSION_DENIED, PERMISSION_DENIED)"))
    }
}
