package com.forta.chat.plugins.tor

import android.os.Build
import android.util.Log
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.regex.Pattern

class ProcessRunner(
    private val tag: String = "ProcessRunner"
) {
    @Volatile private var process: Process? = null
    private var monitorThread: Thread? = null

    interface OutputListener {
        fun onStdOutput(line: String)
        fun onErrOutput(line: String)
    }

    /**
     * Starts the binary and returns without waiting. The process is in place when this
     * returns, so a [stop] called right after reaches it.
     */
    fun launch(
        binaryPath: String,
        args: List<String>,
        env: Map<String, String> = emptyMap(),
        workDir: File? = null,
        listener: OutputListener? = null
    ): Process {
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
        val proc = pb.start()
        process = proc

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

        return proc
    }

    fun stop() {
        process?.let {
            it.destroy()
            try { it.waitFor() } catch (_: Exception) {}
        }
        process = null
    }

    fun isRunning(): Boolean {
        val p = process ?: return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) return p.isAlive
        // Process.isAlive is Android 8+: exitValue() throws while it still runs.
        return try {
            p.exitValue()
            false
        } catch (_: IllegalThreadStateException) {
            true
        }
    }

    companion object {
        private val BOOTSTRAP_PATTERN = Pattern.compile("Bootstrapped (\\d+)%")

        fun parseBootstrapPercent(line: String): Int? {
            val m = BOOTSTRAP_PATTERN.matcher(line)
            return if (m.find()) m.group(1)?.toInt() else null
        }
    }
}
