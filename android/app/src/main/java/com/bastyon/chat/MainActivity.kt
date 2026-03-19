package com.bastyon.chat

import android.os.Bundle
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
    }
}
