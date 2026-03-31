package com.forta.chat.plugins.locale

import android.content.Context
import java.util.Locale

object LocaleHelper {

    private const val PREFS_NAME = "app_locale"
    private const val KEY_LOCALE = "locale"

    fun saveLocale(context: Context, locale: String) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_LOCALE, locale)
            .apply()
    }

    fun getSavedLocale(context: Context): String? {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(KEY_LOCALE, null)
    }

    /**
     * Wraps the given context with the user's in-app locale preference.
     * Falls back to the original context if no preference is saved.
     */
    fun wrapContext(context: Context): Context {
        val localeCode = getSavedLocale(context) ?: return context
        val locale = Locale(localeCode)
        val config = context.resources.configuration
        config.setLocale(locale)
        return context.createConfigurationContext(config)
    }
}
