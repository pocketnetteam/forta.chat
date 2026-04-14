package com.forta.chat

import android.os.Bundle
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.BridgeActivity
import com.forta.chat.plugins.tor.TorPlugin
import com.forta.chat.plugins.calls.CallPlugin
import com.forta.chat.plugins.filetransfer.TorFilePlugin
import com.forta.chat.plugins.webrtc.WebRTCPlugin
import com.forta.chat.plugins.updater.UpdaterPlugin
import com.forta.chat.plugins.push.PushDataPlugin
import com.forta.chat.plugins.locale.LocalePlugin
import com.forta.chat.updater.AppUpdater
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class MainActivity : BridgeActivity() {

    private val activityScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    // Cached inset values (dp) for re-injection after page loads
    private var insetTop = 0
    private var insetBottom = 0
    private var insetLeft = 0
    private var insetRight = 0
    private var keyboardHeight = 0
    private var appBottomInset = 0

    // Named Runnable reference — removable in onDestroy
    private val reinjectAll: Runnable = Runnable { injectAllCssVars() }

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(TorPlugin::class.java)
        registerPlugin(CallPlugin::class.java)
        registerPlugin(TorFilePlugin::class.java)
        registerPlugin(WebRTCPlugin::class.java)
        registerPlugin(UpdaterPlugin::class.java)
        registerPlugin(PushDataPlugin::class.java)
        registerPlugin(LocalePlugin::class.java)
        super.onCreate(savedInstanceState)

        // Edge-to-edge: content draws behind system bars, insets are non-zero
        WindowCompat.setDecorFitsSystemWindows(window, false)

        // Auto-check for updates (respects 1-hour cache)
        activityScope.launch {
            AppUpdater.checkForUpdateIfNeeded(this@MainActivity, isManual = false)
        }

        // Read system bar + IME insets and inject as CSS custom properties.
        // With adjustNothing the system does not resize the WebView — we handle
        // ALL keyboard adaptation via --app-bottom-inset in CSS.
        val rootView = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(rootView) { _, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val density = resources.displayMetrics.density

            insetTop    = (systemBars.top    / density).toInt()
            insetBottom = (systemBars.bottom / density).toInt()
            insetLeft   = (systemBars.left   / density).toInt()
            insetRight  = (systemBars.right  / density).toInt()

            // Pure keyboard height (IME minus nav bar).
            // Clamp to 0..60% screen to guard against OEM firmware anomalies.
            val rawIme  = (ime.bottom / density).toInt()
            val pureKbd = (rawIme - insetBottom).coerceAtLeast(0)
            val maxKbd  = (resources.displayMetrics.heightPixels / density * 0.6).toInt()
            keyboardHeight = pureKbd.coerceAtMost(maxKbd)

            // Total bottom inset: whichever is bigger — IME or nav bar.
            // Used by CSS to shrink the root container above the keyboard/nav bar.
            appBottomInset = (maxOf(ime.bottom, systemBars.bottom) / density).toInt()

            injectAllCssVars()

            // CONSUME insets — do NOT pass through to WebView.
            // Pass-through caused double-resize on Xiaomi/Infinix/MOBI WebViews
            // where both adjustResize AND visual-viewport reacted to IME insets.
            WindowInsetsCompat.CONSUMED
        }
    }

    override fun onResume() {
        super.onResume()
        // Re-inject after resume — WebView may have reloaded or CSS may have been reset
        injectAllCssVars()
    }

    override fun onDestroy() {
        super.onDestroy()
        activityScope.cancel()
        bridge?.webView?.removeCallbacks(reinjectAll)
    }

    /**
     * Inject all layout CSS custom properties in a single JS call.
     *
     * --safe-area-inset-*   : system bar insets (status bar, nav bar)
     * --safe-area-inset-bottom : 0 when keyboard is open (nav bar is behind keyboard)
     * --keyboardheight      : pure keyboard height (used by MediaPreview)
     * --app-bottom-inset    : max(ime, navBar) — total bottom space to avoid
     */
    private fun injectAllCssVars() {
        val webView = bridge?.webView ?: return
        if (isFinishing || isDestroyed) return

        // When keyboard is open, nav bar is behind it — effective safe-area-inset-bottom = 0
        val effectiveBottom = if (keyboardHeight > 0) 0 else insetBottom

        val js = """
            (function() {
                var s = document.documentElement.style;
                s.setProperty('--safe-area-inset-top',    '${insetTop}px');
                s.setProperty('--safe-area-inset-bottom', '${effectiveBottom}px');
                s.setProperty('--safe-area-inset-left',   '${insetLeft}px');
                s.setProperty('--safe-area-inset-right',  '${insetRight}px');
                s.setProperty('--keyboardheight',         '${keyboardHeight}px');
                s.setProperty('--app-bottom-inset',       '${appBottomInset}px');
            })();
        """.trimIndent()

        webView.post { if (!isFinishing && !isDestroyed) webView.evaluateJavascript(js, null) }
        webView.removeCallbacks(reinjectAll)
        webView.postDelayed(reinjectAll, 500)
    }
}
