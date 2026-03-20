package com.forta.chat.plugins.tor

import android.util.Log
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.regex.Pattern

class ProcessRunner(
    private val tag: String = "ProcessRunner"
) {
    private var process: Process? = null
    private var monitorThread: Thread? = null

    interface OutputListener {
        fun onStdOutput(line: String)
        fun onErrOutput(line: String)
    }

    fun start(
        binaryPath: String,
        args: List<String>,
        env: Map<String, String> = emptyMap(),
        workDir: File? = null,
        listener: OutputListener? = null
    ): Int {
        val cmd = mutableListOf(binaryPath) + args
        val pb = ProcessBuilder(cmd)

        val environment = pb.environment()
        for ((k, v) in env) {
            environment[k] = v
        }

        if (workDir != null) {
            pb.directory(workDir)
        }

        pb.redirectErrorStream(false)

        Log.d(tag, "Starting: ${cmd.joinToString(" ")}")
        process = pb.start()

        val proc = process!!

        monitorThread = Thread({
            try {
                BufferedReader(InputStreamReader(proc.inputStream)).use { reader ->
                    var line: String?
                    while (reader.readLine().also { line = it } != null) {
                        Log.d(tag, "[stdout] $line")
                        listener?.onStdOutput(line!!)
                    }
                }
            } catch (e: Exception) {
                Log.e(tag, "stdout reader error", e)
            }
        }, "$tag-stdout").also { it.isDaemon = true; it.start() }

        Thread({
            try {
                BufferedReader(InputStreamReader(proc.errorStream)).use { reader ->
                    var line: String?
                    while (reader.readLine().also { line = it } != null) {
                        Log.w(tag, "[stderr] $line")
                        listener?.onErrOutput(line!!)
                    }
                }
            } catch (e: Exception) {
                Log.e(tag, "stderr reader error", e)
            }
        }, "$tag-stderr").also { it.isDaemon = true; it.start() }

        return proc.waitFor()
    }

    fun stop() {
        process?.let {
            it.destroy()
            try { it.waitFor() } catch (_: Exception) {}
        }
        process = null
    }

    fun isRunning(): Boolean = process?.isAlive == true

    companion object {
        private val BOOTSTRAP_PATTERN = Pattern.compile("Bootstrapped (\\d+)%")

        fun parseBootstrapPercent(line: String): Int? {
            val m = BOOTSTRAP_PATTERN.matcher(line)
            return if (m.find()) m.group(1)?.toInt() else null
        }
    }
}
