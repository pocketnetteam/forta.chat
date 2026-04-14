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

    // Named Runnable references — removable in onDestroy (WR-02 fix per D-13)
    private val reinjectSafeArea: Runnable = Runnable { injectSafeAreaInsets() }
    private val reinjectKeyboard: Runnable = Runnable { injectKeyboardHeight() }

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

            insetTop    = (systemBars.top    / density).toInt()
            insetBottom = (systemBars.bottom / density).toInt()
            insetLeft   = (systemBars.left   / density).toInt()
            insetRight  = (systemBars.right  / density).toInt()

            // With adjustResize: ime.bottom includes nav bar when keyboard is open.
            // Subtract systemBars.bottom (nav bar) to get pure keyboard height.
            // Clamp to 0..60% screen to guard against OEM firmware anomalies (D-05).
            val rawIme  = (ime.bottom / density).toInt()
            val pureKbd = (rawIme - insetBottom).coerceAtLeast(0)
            val maxKbd  = (resources.displayMetrics.heightPixels / density * 0.6).toInt()
            keyboardHeight = pureKbd.coerceAtMost(maxKbd)

            injectSafeAreaInsets()
            injectKeyboardHeight()

            // CRITICAL: Do NOT return WindowInsetsCompat.CONSUMED.
            // Pass insets through so the WebView performs its own visual viewport resize (M139+).
            // This is the D-03 correction layer: on API 30+ with edge-to-edge,
            // pass-through ensures the WebView's visual viewport shrinks correctly.
            ViewCompat.onApplyWindowInsets(view, insets)
        }
    }

    override fun onResume() {
        super.onResume()
        // Re-inject after resume — WebView may have reloaded or CSS may have overridden values
        injectSafeAreaInsets()
        injectKeyboardHeight()
    }

    override fun onDestroy() {
        super.onDestroy()
        activityScope.cancel()                              // WR-01: prevent coroutine leak (D-12)
        bridge?.webView?.removeCallbacks(reinjectSafeArea)  // WR-02: cancel pending safe area re-inject (D-13)
        bridge?.webView?.removeCallbacks(reinjectKeyboard)  // WR-02: cancel pending keyboard re-inject (D-13)
    }

    private fun injectSafeAreaInsets() {
        val webView = bridge?.webView ?: return
        if (isFinishing || isDestroyed) return  // WR-02 guard (D-13)
        val js = """
            (function() {
                var s = document.documentElement.style;
                s.setProperty('--safe-area-inset-top',    '${insetTop}px');
                s.setProperty('--safe-area-inset-bottom', '${insetBottom}px');
                s.setProperty('--safe-area-inset-left',   '${insetLeft}px');
                s.setProperty('--safe-area-inset-right',  '${insetRight}px');
            })();
        """.trimIndent()
        webView.post { if (!isFinishing && !isDestroyed) webView.evaluateJavascript(js, null) }
        webView.removeCallbacks(reinjectSafeArea)       // cancel any pending retry
        webView.postDelayed(reinjectSafeArea, 500)      // named Runnable — removable in onDestroy
    }

    private fun injectKeyboardHeight() {
        val webView = bridge?.webView ?: return
        if (isFinishing || isDestroyed) return  // WR-02 guard (D-13)
        val js = """
            (function() {
                document.documentElement.style.setProperty('--keyboardheight', '${keyboardHeight}px');
            })();
        """.trimIndent()
        webView.post { if (!isFinishing && !isDestroyed) webView.evaluateJavascript(js, null) }
        // No postDelayed retry: adjustResize fires insets only after layout is final (D-02).
    }
}
