package com.forta.chat.plugins.updater

import com.forta.chat.BuildConfig
import com.forta.chat.updater.AppUpdater
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

@CapacitorPlugin(name = "AppUpdater")
class UpdaterPlugin : Plugin() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    @PluginMethod
    fun isEnabled(call: PluginCall) {
        val result = JSObject()
        result.put("enabled", BuildConfig.ENABLE_APP_UPDATER)
        call.resolve(result)
    }

    @PluginMethod
    fun checkForUpdate(call: PluginCall) {
        if (!BuildConfig.ENABLE_APP_UPDATER) {
            call.reject("AppUpdater is disabled for this build")
            return
        }

        val activity = activity ?: run {
            call.reject("Activity not available")
            return
        }

        scope.launch {
            try {
                AppUpdater.checkForUpdateIfNeeded(activity, isManual = true)
                call.resolve()
            } catch (e: Exception) {
                call.reject("Update check failed: ${e.localizedMessage}")
            }
        }
    }
}
