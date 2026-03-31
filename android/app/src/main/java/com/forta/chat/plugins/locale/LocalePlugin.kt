package com.forta.chat.plugins.locale

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "AppLocale")
class LocalePlugin : Plugin() {

    @PluginMethod
    fun setLocale(call: PluginCall) {
        val locale = call.getString("locale") ?: run {
            call.reject("Missing locale parameter")
            return
        }
        LocaleHelper.saveLocale(context, locale)
        call.resolve()
    }
}
