package com.forta.chat.plugins.updater

import com.forta.chat.updater.AppUpdater
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
    fun checkForUpdate(call: PluginCall) {
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
