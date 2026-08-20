package com.forta.chat.plugins.aiinference

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * JS bridge for `AiInferenceForegroundService` — see that class's doc
 * comment for why it exists (background survival for an in-flight AI-chat
 * reply, `docs/plans/llama2/decisions.md`'s "AI-chat background generation"
 * entry). `src/entities/local-ai/lib/ai-inference-keep-alive.adapter.ts`
 * calls this plugin 1:1, bracketing exactly the window
 * `ai-chat-store.ts`'s `sendMessage()` already tracks via `isGenerating`.
 */
@CapacitorPlugin(name = "AiInferenceKeepAlive")
class AiInferencePlugin : Plugin() {

    @PluginMethod
    fun start(call: PluginCall) {
        AiInferenceForegroundService.start(context)
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        AiInferenceForegroundService.stop(context)
        call.resolve()
    }
}
