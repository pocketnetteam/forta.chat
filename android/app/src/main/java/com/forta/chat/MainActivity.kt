package com.forta.chat

import android.app.KeyguardManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import android.view.View.LAYOUT_DIRECTION_LTR
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

    // Named Runnable reference — removable in onDestroy.
    // Kept as a 500ms safety net re-inject after each insets callback to
    // survive flaky OEM WebViews (Xiaomi/MIUI, Infinix, MOBI) where the
    // system insets listener may not fire consistently on IME toggles or
    // WebView internal resets.
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

        // When this activity is launched from the push-call ringer's
        // Accept tap (IncomingCallActivity → push_call_accept=true), the
        // device may still be locked. Without the next few flags the
        // WebView host activity would sit BEHIND the keyguard, Android
        // would immediately mark it stopped, and the WebView would
        // throttle its JS — so our Matrix `answerCall()` flow never
        // completes until the user manually unlocks. Lifting the
        // keyguard for this specific launch lets the call actually
        // answer from the lock screen.
        val cameFromCallAccept = intent?.getBooleanExtra("push_call_accept", false) == true
        if (cameFromCallAccept) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                setShowWhenLocked(true)
                setTurnScreenOn(true)
            } else {
                @Suppress("DEPRECATION")
                window.addFlags(
                    WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                        WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD,
                )
            }
            // Ask keyguard to dismiss if device is locked without a PIN
            // (or to prompt the user otherwise). Without this the WebView
            // is often kept in the onStop state when the OS deems the
            // lock overlay opaque — JS frozen, call hangs in
            // "Connecting…" forever.
            try {
                val km = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
                if (km?.isKeyguardLocked == true && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                    km.requestDismissKeyguard(this, null)
                }
            } catch (_: Throwable) {
                // Best-effort — keyguard dismissal is not critical if the
                // user is willing to unlock manually.
            }
        }

        // BUG-03: Force LTR layout direction on the root view.
        // Prevents Android WebView from inheriting system RTL direction
        // which causes reversed text in portrait on some OEM firmware.
        window.decorView.layoutDirection = LAYOUT_DIRECTION_LTR

        // Edge-to-edge: content draws behind system bars, insets are non-zero
        WindowCompat.setDecorFitsSystemWindows(window, false)

        // Status bar icon color based on current theme (fixes invisible dark
        // icons on dark theme under Android 15+ mandatory edge-to-edge).
        applyStatusBarAppearance()

        // With position:fixed on the root app-shell, document-level scroll
        // does NOT move fixed elements. The browser's native focus-scroll
        // safely reveals inputs within overflow containers while the shell
        // stays put. No scroll prevention needed.

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
            val displayCutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val density = resources.displayMetrics.density

            // Android 16 (Pixel 9/10) with notch/cutout: top inset must equal
            // the max of system bars and display cutout so content clears both.
            val topPx   = maxOf(systemBars.top, displayCutout.top)
            val leftPx  = maxOf(systemBars.left, displayCutout.left)
            val rightPx = maxOf(systemBars.right, displayCutout.right)

            insetTop    = (topPx            / density).toInt()
            insetBottom = (systemBars.bottom / density).toInt()
            insetLeft   = (leftPx           / density).toInt()
            insetRight  = (rightPx          / density).toInt()

            // Pure keyboard height (IME minus nav bar).
            // Clamp to 0..60% screen to guard against OEM firmware anomalies.
            val rawIme  = (ime.bottom / density).toInt()
            val pureKbd = (rawIme - insetBottom).coerceAtLeast(0)
            val maxKbd  = (resources.displayMetrics.heightPixels / density * 0.6).toInt()
            keyboardHeight = pureKbd.coerceAtMost(maxKbd)

            // Total bottom inset: whichever is bigger — IME or nav bar.
            // Used by CSS to shrink the root container above the keyboard/nav bar.
            // Clamp to 60% of screen height to guard against OEM firmware anomalies
            // (MIUI extra padding, Huawei double-reporting of IME insets).
            val maxBottomInset = (resources.displayMetrics.heightPixels / density * 0.6).toInt()
            appBottomInset = (maxOf(ime.bottom, systemBars.bottom) / density).toInt()
                .coerceAtMost(maxBottomInset)

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

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // Theme flipped (dark <-> light) or orientation changed:
        // re-apply status bar icon color and re-inject CSS vars.
        applyStatusBarAppearance()
        injectAllCssVars()
    }

    override fun onDestroy() {
        super.onDestroy()
        activityScope.cancel()
        bridge?.webView?.removeCallbacks(reinjectAll)
    }

    /**
     * Flip status bar / navigation bar icon color to match current theme.
     *
     * Night mode -> icons light (we are on a dark background).
     * Day mode   -> icons dark  (we are on a light background).
     *
     * Without this, Android 15+ leaves icons at their system default
     * (typically dark), which makes them invisible on a dark app background.
     */
    private fun applyStatusBarAppearance() {
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        val nightMode = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
        val isNight = nightMode == Configuration.UI_MODE_NIGHT_YES
        controller.isAppearanceLightStatusBars = !isNight
        controller.isAppearanceLightNavigationBars = !isNight
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
                var d = document.documentElement;
                var s = d.style;
                s.setProperty('--safe-area-inset-top',    '${insetTop}px');
                s.setProperty('--safe-area-inset-bottom', '${effectiveBottom}px');
                s.setProperty('--safe-area-inset-left',   '${insetLeft}px');
                s.setProperty('--safe-area-inset-right',  '${insetRight}px');
                s.setProperty('--keyboardheight',         '${keyboardHeight}px');
                s.setProperty('--app-bottom-inset',       '${appBottomInset}px');
                if (d.getAttribute('dir') !== 'ltr') d.setAttribute('dir', 'ltr');
            })();
        """.trimIndent()

        webView.post { if (!isFinishing && !isDestroyed) webView.evaluateJavascript(js, null) }
        // 500ms safety-net re-inject: some OEM WebViews (Xiaomi/MIUI,
        // Infinix, MOBI) do not reliably re-dispatch window insets after
        // IME toggles or internal WebView resets. This backup re-inject
        // keeps --keyboardheight / --app-bottom-inset in sync on those
        // devices without waiting for the next insets callback.
        webView.removeCallbacks(reinjectAll)
        webView.postDelayed(reinjectAll, 500)
    }
}
