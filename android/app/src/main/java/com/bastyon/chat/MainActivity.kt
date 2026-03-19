package com.bastyon.chat

import android.os.Bundle
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.getcapacitor.BridgeActivity
import com.bastyon.chat.plugins.tor.TorPlugin
import com.bastyon.chat.plugins.calls.CallPlugin
import com.bastyon.chat.plugins.filetransfer.TorFilePlugin
import com.bastyon.chat.plugins.webrtc.WebRTCPlugin

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(TorPlugin::class.java)
        registerPlugin(CallPlugin::class.java)
        registerPlugin(TorFilePlugin::class.java)
        registerPlugin(WebRTCPlugin::class.java)
        super.onCreate(savedInstanceState)

        // Inject real safe area insets as CSS variables into the WebView
        val rootView = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(rootView) { view, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val density = resources.displayMetrics.density
            val top = (systemBars.top / density).toInt()
            val bottom = (systemBars.bottom / density).toInt()
            val left = (systemBars.left / density).toInt()
            val right = (systemBars.right / density).toInt()

            bridge?.webView?.post {
                bridge?.webView?.evaluateJavascript(
                    """
                    document.documentElement.style.setProperty('--safe-area-inset-top', '${top}px');
                    document.documentElement.style.setProperty('--safe-area-inset-bottom', '${bottom}px');
                    document.documentElement.style.setProperty('--safe-area-inset-left', '${left}px');
                    document.documentElement.style.setProperty('--safe-area-inset-right', '${right}px');
                    """.trimIndent(),
                    null
                )
            }

            ViewCompat.onApplyWindowInsets(view, insets)
        }
    }
}
