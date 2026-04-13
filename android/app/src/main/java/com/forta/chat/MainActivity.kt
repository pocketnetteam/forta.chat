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
import kotlinx.coroutines.launch

class MainActivity : BridgeActivity() {

    private val activityScope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    // Cached inset values (dp) for re-injection after page loads
    private var insetTop = 0
    private var insetBottom = 0
    private var insetLeft = 0
    private var insetRight = 0
    private var keyboardHeight = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(TorPlugin::class.java)
        registerPlugin(CallPlugin::class.java)
        registerPlugin(TorFilePlugin::class.java)
        registerPlugin(WebRTCPlugin::class.java)
        registerPlugin(UpdaterPlugin::class.java)
        registerPlugin(PushDataPlugin::class.java)
        registerPlugin(LocalePlugin::class.java)
        super.onCreate(savedInstanceState)

        // Enable edge-to-edge: content draws behind system bars, insets are non-zero
        WindowCompat.setDecorFitsSystemWindows(window, false)

        // Auto-check for updates (respects 1-hour cache)
        activityScope.launch {
            AppUpdater.checkForUpdateIfNeeded(this@MainActivity, isManual = false)
        }

        // Inject real safe area insets + keyboard height as CSS variables into the WebView.
        // With edge-to-edge enabled, adjustResize alone doesn't resize the window on API 30+.
        // We must explicitly read Type.ime() insets to get keyboard height.
        val rootView = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(rootView) { view, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val density = resources.displayMetrics.density

            insetTop = (systemBars.top / density).toInt()
            insetBottom = (systemBars.bottom / density).toInt()
            insetLeft = (systemBars.left / density).toInt()
            insetRight = (systemBars.right / density).toInt()

            // IME bottom includes navigation bar height — subtract it for pure keyboard height.
            // Clamp to 60% of screen to protect against OEM firmware reporting bogus values.
            val rawKeyboard = (ime.bottom / density).toInt()
            val pureKeyboard = if (rawKeyboard > insetBottom) rawKeyboard - insetBottom else 0
            val screenHeightDp = (resources.displayMetrics.heightPixels / density).toInt()
            keyboardHeight = pureKeyboard.coerceAtMost((screenHeightDp * 0.6).toInt())

            injectSafeAreaInsets()
            injectKeyboardHeight()
            ViewCompat.onApplyWindowInsets(view, insets)
        }
    }

    override fun onResume() {
        super.onResume()
        // Re-inject after resume — WebView may have reloaded or CSS may have overridden values
        injectSafeAreaInsets()
        injectKeyboardHeight()
    }

    private fun injectSafeAreaInsets() {
        val webView = bridge?.webView ?: return
        val js = """
            (function() {
                var s = document.documentElement.style;
                s.setProperty('--safe-area-inset-top', '${insetTop}px');
                s.setProperty('--safe-area-inset-bottom', '${insetBottom}px');
                s.setProperty('--safe-area-inset-left', '${insetLeft}px');
                s.setProperty('--safe-area-inset-right', '${insetRight}px');
            })();
        """.trimIndent()
        webView.post { webView.evaluateJavascript(js, null) }
        // Re-inject after a delay to ensure CSS hasn't overridden values after page load
        webView.postDelayed({ webView.evaluateJavascript(js, null) }, 1000)
    }

    private fun injectKeyboardHeight() {
        val webView = bridge?.webView ?: return
        val js = """
            (function() {
                document.documentElement.style.setProperty('--native-keyboard-height', '${keyboardHeight}px');
                window.dispatchEvent(new CustomEvent('native-keyboard-change', { detail: { height: ${keyboardHeight} } }));
            })();
        """.trimIndent()
        webView.post { webView.evaluateJavascript(js, null) }
        // Second injection at +100ms covers devices where the IME inset fires before
        // the keyboard animation settles (1-3 frame latency on slow Android 7 hardware).
        webView.postDelayed({ webView.evaluateJavascript(js, null) }, 100)
    }
}
