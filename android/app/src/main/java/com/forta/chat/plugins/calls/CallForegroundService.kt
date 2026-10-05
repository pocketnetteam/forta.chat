package com.forta.chat.plugins.calls

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import com.forta.chat.R
import com.forta.chat.plugins.locale.LocaleHelper
import com.forta.chat.plugins.webrtc.WebRTCPlugin
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Foreground service that keeps the call alive when the app is backgrounded.
 *
 * Responsibilities:
 * - Persistent notification showing call status (required for foreground service)
 * - Audio focus management (pause other apps' audio during call)
 * - Wakelock to prevent CPU sleep during active call
 * - Lifecycle tied to call duration
 */
class CallForegroundService : Service() {

    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(LocaleHelper.wrapContext(newBase))
    }

    companion object {
        private const val TAG = "CallForegroundService"
        private const val CHANNEL_ID = "active_call"
        private const val NOTIFICATION_ID = 10001
        private const val WAKELOCK_TAG = "forta:call_wakelock"

        const val ACTION_START = "com.forta.chat.CALL_START"
        const val ACTION_STOP = "com.forta.chat.CALL_STOP"
        const val ACTION_UPDATE = "com.forta.chat.CALL_UPDATE"
        const val ACTION_HANGUP = "com.forta.chat.CALL_HANGUP"

        const val EXTRA_CALLER_NAME = "callerName"
        const val EXTRA_CALL_TYPE = "callType"
        const val EXTRA_STATUS = "status"
        const val EXTRA_DURATION = "duration"

        /**
         * Start generation carried by ACTION_START and ACTION_STOP. A stop is
         * honoured only for the generation it was issued against: a hangup
         * followed by an immediate redial sends the old call's stop after the
         * new call's start (JS drops `hasLiveCall` the moment the SDK call
         * ends, before its finalize reaches the native steps), and an unkeyed
         * stop then tore down the new call — its notification, its wake-lock
         * and, through forceStop, its audio. Bumped synchronously in [start],
         * before the intent is sent, so everything that reads the counter
         * after that call — a stop for the previous call, a deferred teardown
         * of the previous instance — already sees the new call as the owner.
         * A stop names its call and is issued against the generation that
         * call's start recorded ([CallStartLedger]), not the current one.
         * See [CallServiceStopPolicy].
         */
        const val EXTRA_GENERATION = "startGeneration"
        private val startGeneration = java.util.concurrent.atomic.AtomicLong(0L)
        private val startLedger = CallStartLedger()

        fun start(context: Context, callerName: String, callType: String, callId: String? = null) {
            val generation = startGeneration.incrementAndGet()
            startLedger.record(callId, generation)
            val intent = Intent(context, CallForegroundService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_CALLER_NAME, callerName)
                putExtra(EXTRA_CALL_TYPE, callType)
                putExtra(EXTRA_GENERATION, generation)
                callId?.let { putExtra(CallActivity.EXTRA_CALL_ID, it) }
            }
            try {
                // ContextCompat: plain startService below Android 8, where
                // startForegroundService does not exist (minSdk 24).
                androidx.core.content.ContextCompat.startForegroundService(context, intent)
            } catch (e: Throwable) {
                // WEE-31: Android 12+ ForegroundServiceStartNotAllowedException
                // when the call accept path is invoked from a context the OS
                // doesn't consider eligible to start an FGS (e.g. an OEM
                // killed the app between the FCM push and the user tap).
                // Logging-only — caller's accept flow will surface the audio
                // error through AudioRouter and the user can retry. Without
                // this, the throw would crash the callee process.
                Log.e(TAG, "[callee-crash-guard] startForegroundService rejected", e)
            }
        }

        fun updateStatus(context: Context, status: String, duration: String = "") {
            // Nothing to update without a running service, and startService
            // from the background (locked phone, no foreground service) throws
            // BackgroundServiceStartNotAllowedException on Android 12+, which
            // took the whole process down from the plugin thread. A started
            // instance created just for this update also lingered, reading as
            // a live call to the router's watchdog and the idle exit.
            if (!isRunning) {
                Log.d(TAG, "updateStatus($status) with no call service running — skipped")
                return
            }
            val intent = Intent(context, CallForegroundService::class.java).apply {
                action = ACTION_UPDATE
                putExtra(EXTRA_STATUS, status)
                putExtra(EXTRA_DURATION, duration)
            }
            try {
                context.startService(intent)
            } catch (e: Exception) {
                Log.w(TAG, "updateStatus rejected by the system", e)
            }
        }

        /**
         * Stop the service for [callId]. The stop is issued against the
         * generation that call's start recorded, so a stop for the previous
         * call issued after the next call's start is stale on delivery. A stop
         * without an id, or for a call no start recorded, is issued against
         * the current generation.
         */
        fun stop(context: Context, callId: String? = null) {
            val intent = Intent(context, CallForegroundService::class.java).apply {
                action = ACTION_STOP
                putExtra(EXTRA_GENERATION, startLedger.generationFor(callId, startGeneration.get()))
            }
            // Reached from every call teardown. From the background with the
            // service already gone, Android 12+ refuses the start and the
            // throw crashed the process; there is nothing left to stop then.
            try {
                context.startService(intent)
            } catch (e: Exception) {
                Log.w(TAG, "stop rejected by the system (service not running: ${!isRunning})", e)
            }
        }

        /**
         * Whether a teardown step for [callId] belongs to a call that a newer
         * [start] has since replaced. The JS finalize runs its process-wide
         * steps one by one; a step that reaches native after the next call's
         * launchCallUI must leave that call alone. An unnamed step, or one
         * for a call no start recorded, is current, as before.
         */
        fun isStartStale(callId: String?): Boolean {
            val current = startGeneration.get()
            return CallServiceStopPolicy.isStale(startLedger.generationFor(callId, current), current)
        }

        /** See [CallStartLedger.alias]: the Telecom slot's id stops the same start JS launched. */
        fun aliasCall(alias: String?, callId: String?) = startLedger.alias(alias, callId)

        // D-10: Re-request audio focus from CallActivity.onResume.
        // Session 54: @Volatile so the isRunning getter can be read safely
        // from non-main threads if a future caller does so. Today all
        // readers are on the main thread (watchdog + CallActivity.onResume),
        // but the cost of @Volatile is a single memory barrier so the
        // safety win is free.
        /**
         * Single worker for the blocking WebRTC teardown. Static so the work
         * survives the service instance that scheduled it.
         */
        private val mediaReleaseExecutor: ExecutorService =
            Executors.newSingleThreadExecutor { r -> Thread(r, "forta-call-media-release") }

        @Volatile
        private var instance: CallForegroundService? = null

        /**
         * Session 54: exposed read-only liveness flag. Other call surfaces
         * (AudioRouter orphan watchdog, CallActivity.onResume) need to know
         * whether the foreground service is actually running before
         * restoring MODE_IN_COMMUNICATION — assuming the service is up just
         * because we have a saved Activity reference is what produced the
         * orphan VoIP-mode bug (#708 / #462). Kept as a property getter so
         * the underlying `instance` reference can stay private.
         */
        @JvmStatic
        val isRunning: Boolean
            get() = instance != null

        fun reRequestAudioFocus(context: Context) {
            instance?.requestAudioFocus()
                ?: Log.w("WebRTCAudio", "reRequestAudioFocus: service not running")
        }

        /**
         * Telecom has created the Connection for the call being dialled. It took
         * audio focus for that call before creating it, and the focus listener
         * usually hears that loss first and mutes the mic; undo it, or the call
         * goes out silent until hangup. A no-op when nothing was muted. See
         * [FocusLossMute].
         */
        fun onTelecomTookCall() {
            instance?.releaseFocusLossMute("Telecom took the outgoing call")
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    // Android 7: focus held through the stream-based API, no request object.
    private var legacyFocusHeld = false
    // The one volume change the focus listener owns (a duck). Main thread only.
    private val focusDuck = FocusDuckVolume()
    // The one mic mute the focus listener owns. Main thread only: the focus
    // listener and Telecom's connection callbacks both run there.
    private val focusLossMute = FocusLossMute()
    // WEE-45: NotificationCompat.CallStyle.forOngoingCall throws
    // IllegalArgumentException when the Person it wraps has an empty
    // name. On a second call right after the first one stopped, the
    // OS sometimes delivers ACTION_UPDATE to a freshly-recreated service
    // instance BEFORE ACTION_START runs (lifecycle race observed on
    // Samsung One UI / Z Flip 4), at which point `callerName` is still
    // the empty default. Initialising to a non-empty fallback keeps the
    // notification builder safe even if updateNotification is ever
    // invoked before the real caller name is known. The fallback is the
    // app's display label so the notification still reads sensibly.
    private var callerName = "Forta Chat"
    private var callType = ""
    private var callId = ""
    // Tracks whether ACTION_START actually populated callerName/callType
    // for this service instance. Lets ACTION_UPDATE detect the
    // out-of-order delivery path and ignore the update instead of
    // rendering a placeholder Person — the next legitimate START will
    // build the notification correctly with the real caller name.
    private var hasStarted: Boolean = false
    // The start generation this instance runs; -1 until ACTION_START. Compared
    // with the counter in [isStale] before any process-wide teardown.
    private var generation: Long = -1L

    private val binder = LocalBinder()

    inner class LocalBinder : Binder() {
        fun getService(): CallForegroundService = this@CallForegroundService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        instance = this
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                // Coalesce blank/missing values to non-empty defaults — the
                // Android NotificationCompat.CallStyle person-name guard is
                // strict and rejects empty strings (not just nulls).
                val incomingName = intent.getStringExtra(EXTRA_CALLER_NAME)
                callerName = if (incomingName.isNullOrBlank()) "Unknown" else incomingName
                callType = intent.getStringExtra(EXTRA_CALL_TYPE) ?: "voice"
                callId = intent.getStringExtra(CallActivity.EXTRA_CALL_ID).orEmpty()
                hasStarted = true
                generation = intent.getLongExtra(EXTRA_GENERATION, -1L)
                // Re-assert liveness: a stop that ran on this same instance
                // cleared `instance`, and Android reuses the instance for a
                // start that arrives before the deferred destroy. Without this
                // the new call reads as not running, and the router's orphan
                // watchdog would take its audio down as an orphan.
                instance = this
                startForegroundWithNotification(getString(R.string.call_connecting))
                acquireWakeLock()
                requestAudioFocus()
                Log.d(TAG, "Service started for call with $callerName")
            }
            ACTION_UPDATE -> {
                // WEE-45: ignore ACTION_UPDATE that arrives before ACTION_START
                // populated this instance. On Samsung One UI the OS occasionally
                // delivers a stale UPDATE intent to a freshly-recreated service
                // process (second call right after the first stopped); without
                // this guard, buildNotification would call
                // CallStyle.forOngoingCall with the fallback caller name and
                // dump a misleading notification, or — pre-WEE-45 — crash with
                // `person must have a non-empty a name` when callerName was "".
                if (!hasStarted) {
                    Log.w(TAG, "ACTION_UPDATE before ACTION_START — ignoring stale update")
                    // An instance created for this update alone must not stay
                    // started; stopSelf(startId) spares a start queued after it.
                    stopSelf(startId)
                    return START_NOT_STICKY
                }
                val status = intent.getStringExtra(EXTRA_STATUS) ?: ""
                val duration = intent.getStringExtra(EXTRA_DURATION) ?: ""
                val text = if (duration.isNotEmpty()) "$status - $duration" else status
                updateNotification(text)
            }
            ACTION_HANGUP -> {
                // "Hang up" on the ongoing-call notification does what the call
                // screen's button does: JS hangs the call up (m.call.hangup, then
                // its teardown stops this service) and the screen closes. It used
                // to close the screen and stop the service only — the peer was
                // never told and stayed in a silent call.
                CallActivity.onNativeHangup?.invoke()
                CallActivity.onCallEnded?.invoke()
            }
            ACTION_STOP -> {
                val stopGeneration = intent.getLongExtra(EXTRA_GENERATION, -1L)
                if (CallServiceStopPolicy.isStale(stopGeneration, startGeneration.get())) {
                    Log.w(
                        TAG,
                        "ACTION_STOP for start generation $stopGeneration ignored — " +
                            "a newer call started (generation ${startGeneration.get()})",
                    )
                    return START_NOT_STICKY
                }
                hasStarted = false
                releaseWakeLock()
                abandonAudioFocus()
                stopForeground(STOP_FOREGROUND_REMOVE)
                // Same reasoning as onTaskRemoved: stopSelf() reaches onDestroy
                // eventually, but OEM ROMs defer it, and until then `isRunning`
                // still reads true and the router's orphan watchdog treats the
                // call as alive. Release the audio session and clear liveness
                // now; onDestroy's own pass is idempotent.
                if (!isSuperseded()) {
                    runCatching {
                        AudioRouter.getSharedInstance(applicationContext).forceStop("fgs_stop")
                    }.onFailure { Log.w(TAG, "AudioRouter.forceStop in ACTION_STOP threw", it) }
                    instance = null
                }
                stopSelf()
                Log.d(TAG, "Service stopped")
            }
        }
        return START_NOT_STICKY
    }

    /**
     * True when a *newer* service instance has already taken over.
     *
     * `stopSelf()` → `onDestroy()` is asynchronous, and OEM ROMs defer it
     * further, so the OS can run a superseded instance's teardown long after
     * the next call has created and started a fresh service. Everything in
     * that teardown is process-wide — the audio mode and the WebRTC
     * PeerConnections are global, not per-instance — so running it from a
     * dead instance would mute or drop a call that is currently live. A
     * superseded instance therefore releases only what it actually owns: its
     * own wake-lock and its own audio-focus request.
     */
    private fun isSuperseded(): Boolean {
        val live = instance
        return live != null && live !== this
    }

    /**
     * True when this instance's call is no longer the one the service was last
     * started for: a newer instance took over ([isSuperseded]), or [start] has
     * been issued for the next call and its intent is still on its way. A
     * successor's onCreate never runs before this instance's onDestroy, so
     * the identity check alone can only ever see the *previous* owner; the
     * counter, bumped before the start intent is sent, is what tells a
     * deferred teardown that the next call already owns the audio mode and
     * the PeerConnections.
     */
    private fun isStale(): Boolean {
        return isSuperseded() || CallServiceStopPolicy.isStale(generation, startGeneration.get())
    }

    /**
     * Close the WebRTC capture path on a worker thread.
     *
     * Static executor: the work has to outlive the service instance that
     * scheduled it, and both teardown paths can schedule it in the same call
     * cycle. closeAllPeerConnections is idempotent, so the second run is a
     * no-op rather than a double teardown.
     */
    private fun releaseMediaAsync(from: String) {
        // The owner check at the call site covers the moment of scheduling; the
        // worker checks again at run time, because the PeerConnections are
        // global and the next call may have created its own while this task
        // waited behind a slow stopCapture.
        val owner = generation
        runCatching {
            mediaReleaseExecutor.execute {
                if (CallServiceStopPolicy.isStale(owner, startGeneration.get())) {
                    Log.w(TAG, "media release from $from skipped — a newer call started")
                    return@execute
                }
                runCatching { WebRTCPlugin.manager?.closeAllPeerConnections() }
                    .onFailure { Log.w(TAG, "closeAllPeerConnections from $from threw", it) }
            }
        }.onFailure { Log.w(TAG, "could not schedule media release from $from", it) }
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        if (isStale()) {
            Log.w(TAG, "onTaskRemoved on a stale instance - skipping global teardown")
            hasStarted = false
            releaseWakeLock()
            abandonAudioFocus()
            super.onTaskRemoved(rootIntent)
            stopSelf()
            return
        }
        // WEE-54 / forta-bugs#839 (reopen): when the user swipes the app out of
        // Recents during or right after a call, Android delivers onTaskRemoved
        // but does NOT always call onDestroy promptly — the OS can keep the
        // service record around (especially on OEM ROMs), so AudioRouter stays
        // in MODE_IN_COMMUNICATION and the cellular network is blocked until
        // reboot. WEE-49 only hardened onDestroy(); this swipe-out path slipped
        // through, which is why #839 reopened on 1.10.31. Mirror the onDestroy
        // brute-force cleanup here and stopSelf() so teardown is deterministic.
        runCatching {
            AudioRouter.getSharedInstance(applicationContext).forceStop()
        }.onFailure { Log.w(TAG, "AudioRouter.forceStop in onTaskRemoved threw", it) }

        // Nothing here used to close the WebRTC side at all, so a swipe-out
        // left AudioRecord held by the app — "the mic keeps being used by
        // forta" (#997). Worse, startLocalAudio early-returns while
        // localAudioTrack is non-null, so the orphaned track (bound to a dead
        // PeerConnection) poisoned the next call too. closeAllPeerConnections
        // → stopLocalMedia disposes both.
        //
        // Off the main thread, unlike the audio-mode reset above: this path
        // blocks on videoCapturer.stopCapture(), which waits for the capture
        // thread to actually stop and can take a second on an old camera HAL —
        // an ANR on a lifecycle callback that runs while the rest of the app is
        // still on screen. Everywhere else in the app this method is reached
        // from Capacitor's plugin thread, never the UI one.
        //
        // Async is safe *here specifically* because the microphone is
        // process-local: if the process dies before this runs, the OS reclaims
        // the capture anyway. The audio mode is the opposite — it is global and
        // outlives the process — which is why forceStop above stays synchronous.
        releaseMediaAsync("onTaskRemoved")

        runCatching {
            stopForeground(STOP_FOREGROUND_REMOVE)
        }.onFailure { Log.w(TAG, "stopForeground in onTaskRemoved threw", it) }

        hasStarted = false
        releaseWakeLock()
        abandonAudioFocus()
        // Clear liveness NOW, not in the (possibly deferred) onDestroy. The
        // audio mode has already been torn down above, but `isRunning` is what
        // the AudioRouter orphan watchdog and CallActivity.onResume consult
        // before restoring MODE_IN_COMMUNICATION. If we left `instance`
        // non-null until the OS finally runs onDestroy, a surface waking in
        // that window would see a "running" call and re-apply comm mode —
        // re-stranding the audio and re-creating the orphan VoIP-mode bug
        // (#708 / #462) that this whole cellular-unblock fix targets. Nulling
        // here keeps liveness consistent with the teardown that just ran;
        // onDestroy setting it null again is an idempotent no-op.
        instance = null

        // Last, and only here. Telecom's connection and the pending answer/
        // reject markers are the two call resources that do not live in this
        // service, so nothing above reaches them; left alone they park the
        // device in MODE_IN_COMMUNICATION and make every later call in this
        // process unringable.
        //
        // After `instance = null` and the audio teardown on purpose:
        // onDisconnect re-enters CallTeardown.endCall(DISCONNECT), and with the
        // router already down and liveness already cleared that nested
        // decide() returns no actions — instead of STOP_FOREGROUND_SERVICE,
        // which would be a startService() into a service that is mid-destruction.
        runCatching { CallConnectionService.releaseOnTaskRemoved() }
            .onFailure { Log.w(TAG, "releaseOnTaskRemoved in onTaskRemoved threw", it) }

        super.onTaskRemoved(rootIntent)
        // stopSelf so the OS finalises the service (and runs onDestroy) instead
        // of leaving a zombie service record holding the audio mode.
        stopSelf()
    }

    override fun onDestroy() {
        if (isStale()) {
            Log.w(TAG, "onDestroy on a stale instance - skipping global teardown")
            hasStarted = false
            releaseWakeLock()
            abandonAudioFocus()
            super.onDestroy()
            return
        }
        // WEE-49: when the OS tears the service down without going through
        // ACTION_STOP (process killed by OEM Doze, swipe-app-out, low-mem
        // SIGKILL, system-initiated `stopWithReason`), the previous teardown
        // only released the wake-lock + abandoned audio focus. AudioRouter
        // stayed in MODE_IN_COMMUNICATION, holding the voice-call audio
        // mode globally and blocking cellular network until reboot
        // (#839 post-WEE-45 residual, #771 phantom call). Brute-force reset
        // the router and pull the notification surface explicitly so the
        // OS recognises the call as fully ended.
        runCatching {
            AudioRouter.getSharedInstance(applicationContext).forceStop()
        }.onFailure { Log.w(TAG, "AudioRouter.forceStop in onDestroy threw", it) }

        // Nothing here used to close the WebRTC side at all, so a swipe-out
        // left AudioRecord held by the app — "the mic keeps being used by
        // forta" (#997). Worse, startLocalAudio early-returns while
        // localAudioTrack is non-null, so the orphaned track (bound to a dead
        // PeerConnection) poisoned the next call too. closeAllPeerConnections
        // → stopLocalMedia disposes both.
        //
        // Off the main thread, unlike the audio-mode reset above: this path
        // blocks on videoCapturer.stopCapture(), which waits for the capture
        // thread to actually stop and can take a second on an old camera HAL —
        // an ANR on a lifecycle callback that runs while the rest of the app is
        // still on screen. Everywhere else in the app this method is reached
        // from Capacitor's plugin thread, never the UI one.
        //
        // Async is safe *here specifically* because the microphone is
        // process-local: if the process dies before this runs, the OS reclaims
        // the capture anyway. The audio mode is the opposite — it is global and
        // outlives the process — which is why forceStop above stays synchronous.
        releaseMediaAsync("onDestroy")

        runCatching {
            stopForeground(STOP_FOREGROUND_REMOVE)
        }.onFailure { Log.w(TAG, "stopForeground in onDestroy threw", it) }

        hasStarted = false
        releaseWakeLock()
        abandonAudioFocus()
        instance = null
        // Ends a process left with nothing to present — see IdleProcessExit.
        IdleProcessExit.schedule(applicationContext, "call service destroyed")
        super.onDestroy()
    }

    // -----------------------------------------------------------------------
    // Notification
    // -----------------------------------------------------------------------

    private fun createNotificationChannel() {
        // Channels exist from Android 8; below it the class is missing and this
        // threw from onCreate, killing the process at every call.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.channel_active_call),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.channel_active_call_desc)
            setSound(null, null)
            enableVibration(false)
        }
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(channel)
    }

    private fun startForegroundWithNotification(status: String) {
        val notification = buildNotification(status)
        // Android 14+ (API 34) requires the foreground-service type bitmask
        // at startForeground time. Without it the platform throws
        // ForegroundServiceTypeException and the process crashes immediately
        // when the user accepts a call (#640, #623, #624).
        // We declare both microphone and phoneCall so the OS recognises the
        // service as a real call surface AND a legitimate audio capturer —
        // either flag alone is rejected on Pixel 6 Pro / Samsung A05 / etc.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            try {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL,
                )
                return
            } catch (e: SecurityException) {
                // RECORD_AUDIO permission revoked between accept and FGS
                // start — fall back to the call-only type so the notification
                // still appears and the user can hang up. AudioRouter will
                // surface the missing-mic error through the JS bridge.
                Log.e(TAG, "FGS_TYPE_MICROPHONE rejected, falling back to phoneCall-only", e)
                try {
                    startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL,
                    )
                    return
                } catch (e2: Throwable) {
                    // WEE-31: even phoneCall-only can be rejected on some
                    // OEM builds (HarmonyOS) or when the OS thinks the
                    // service was started from a disallowed background
                    // context. Fall through to the untyped path below.
                    Log.e(TAG, "[callee-crash-guard] phoneCall-only startForeground rejected", e2)
                }
            } catch (e: Throwable) {
                // WEE-31 (H2): Android 12+ ForegroundServiceStartNotAllowedException
                // when startForegroundService → startForeground timing slips
                // past the 5s background-start window (FCM-triggered path
                // is most exposed). InvalidForegroundServiceTypeException on
                // a few Xiaomi / HarmonyOS builds. Either of these used to
                // process-kill the callee "наглухо".
                Log.e(TAG, "[callee-crash-guard] typed startForeground threw, retrying untyped", e)
            }
        }
        // Untyped fallback path (pre-Android-14, or post-Android-14 after
        // a typed startForeground failure). Still wrapped so an exotic
        // OEM that disallows even this can't kill the process.
        try {
            startForeground(NOTIFICATION_ID, notification)
        } catch (e: Throwable) {
            Log.e(TAG, "[callee-crash-guard] untyped startForeground also failed; service will run without FGS", e)
            // Best-effort: post the notification through the manager so the
            // user still sees the ongoing call surface (no FGS lifetime
            // guarantees but the call thread is alive). stopSelf if even
            // that fails — never let the service-start path crash the
            // process.
            runCatching {
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.notify(NOTIFICATION_ID, notification)
            }
        }
    }

    private fun updateNotification(status: String) {
        val notification = buildNotification(status)
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, notification)
    }

    private fun buildNotification(status: String): Notification {
        // Carry the call along: a tap after the call screen was closed creates
        // a fresh CallActivity, which otherwise showed "Unknown", assumed a
        // video call (camera prompt on a voice call) and had no call id.
        val contentIntent = Intent(this, CallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(CallActivity.EXTRA_CALLER_NAME, callerName)
            putExtra(CallActivity.EXTRA_CALL_TYPE, callType.ifEmpty { "voice" })
            if (callId.isNotEmpty()) putExtra(CallActivity.EXTRA_CALL_ID, callId)
        }
        val contentPendingIntent = PendingIntent.getActivity(
            this, 0, contentIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val hangupIntent = Intent(this, CallForegroundService::class.java).apply {
            action = ACTION_HANGUP
        }
        val hangupPendingIntent = PendingIntent.getService(
            this, 1, hangupIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val typeLabel = if (callType == "video") getString(R.string.call_video_call) else getString(R.string.call_voice_call)

        // WEE-45: NotificationCompat.CallStyle throws on empty Person names.
        // The instance fallback above should keep callerName non-empty, but
        // a final guard here ensures any future code path that mutates
        // callerName cannot crash the foreground service. The fallback is
        // a sensible app label — never user-controlled, never blank.
        val safeCallerName = if (callerName.isBlank()) "Forta Chat" else callerName
        val caller = androidx.core.app.Person.Builder()
            .setName(safeCallerName)
            .setImportant(true)
            .build()

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(contentPendingIntent)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
            builder.setStyle(
                NotificationCompat.CallStyle.forOngoingCall(caller, hangupPendingIntent)
            )
            builder.setContentText(status)
        } else {
            builder.setContentTitle(if (callType == "video") getString(R.string.call_video_call_with, safeCallerName) else getString(R.string.call_voice_call_with, safeCallerName))
            builder.setContentText(status)
            builder.addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                getString(R.string.call_hang_up),
                hangupPendingIntent
            )
        }

        return builder.build()
    }

    // -----------------------------------------------------------------------
    // Audio Focus
    // -----------------------------------------------------------------------

    // D-09: Full audio focus change listener with duck/mute/restore
    private val audioFocusChangeListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        when (focusChange) {
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                // D-09: Lower volume to ~30%
                Log.d("WebRTCAudio", "Focus: DUCK — lowering volume")
                audioManager?.let { am ->
                    val target = focusDuck.onDuck(
                        current = am.getStreamVolume(AudioManager.STREAM_VOICE_CALL),
                        max = am.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL),
                    )
                    if (target >= 0) am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, target, 0)
                }
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                // D-09: Mute local mic — unless the focus went to Telecom for our
                // own call, which is the call itself, not an interruption.
                if (focusLossMute.onTransientLoss(telecomOwnsCall = CallConnectionService.currentConnection != null)) {
                    Log.d("WebRTCAudio", "Focus: TRANSIENT_LOSS — muting mic")
                    WebRTCPlugin.manager?.setAudioEnabled(false)
                } else {
                    Log.d("WebRTCAudio", "Focus: TRANSIENT_LOSS while our Telecom call is up — mic stays on")
                }
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                // D-09: Restore volume + unmute
                Log.d("WebRTCAudio", "Focus: GAIN — restoring audio")
                restoreDuckedVolume()
                releaseFocusLossMute("focus regained")
            }
            AudioManager.AUDIOFOCUS_LOSS -> {
                // D-09: Permanent loss — log warning, don't drop the call
                Log.w("WebRTCAudio", "Focus: PERMANENT_LOSS — warning only, call continues")
            }
            else -> {
                Log.d("WebRTCAudio", "Focus: unknown change=$focusChange")
            }
        }
    }

    /** Undo a duck still in force, unless the user moved the volume since. */
    private fun restoreDuckedVolume() {
        val am = audioManager ?: return
        try {
            val restore = focusDuck.release(am.getStreamVolume(AudioManager.STREAM_VOICE_CALL))
            if (restore >= 0) am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, restore, 0)
        } catch (e: Exception) {
            Log.w("WebRTCAudio", "Failed to restore voice call volume", e)
        }
    }

    /**
     * Undo the mute a transient focus loss applied — and only that one, so a
     * mute the user chose survives focus coming back.
     */
    private fun releaseFocusLossMute(reason: String) {
        if (!focusLossMute.release()) return
        Log.d("WebRTCAudio", "Unmuting the mic a focus loss muted: $reason")
        WebRTCPlugin.manager?.setAudioEnabled(true)
    }

    private fun requestAudioFocus() {
        val am = audioManager ?: return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // AudioFocusRequest is Android 8+; Android 7 takes the stream form.
            @Suppress("DEPRECATION")
            runCatching { am.abandonAudioFocus(audioFocusChangeListener) }
            @Suppress("DEPRECATION")
            val result = am.requestAudioFocus(
                audioFocusChangeListener,
                AudioManager.STREAM_VOICE_CALL,
                AudioManager.AUDIOFOCUS_GAIN,
            )
            legacyFocusHeld = true
            Log.d("WebRTCAudio", "Audio focus requested (GAIN, legacy), result=$result")
            return
        }

        // Release the previous request before building another one. This is not
        // a one-shot call: CallActivity.onResume re-requests on every return to
        // the app — PiP exit, unlock, task switch — and each overwrite used to
        // strand the earlier AUDIOFOCUS_GAIN request, which only the last one
        // ever abandoned.
        audioFocusRequest?.let {
            runCatching { am.abandonAudioFocusRequest(it) }
                .onFailure { e -> Log.w("WebRTCAudio", "abandon before re-request threw", e) }
            audioFocusRequest = null
        }

        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

        // Use AUDIOFOCUS_GAIN (not TRANSIENT) — Chinese OEM firmwares (MIUI,
        // RealmeUI, XOS) may return audio focus prematurely with transient mode,
        // causing zero-way audio. Full gain properly displaces media players.
        audioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(attrs)
            .setAcceptsDelayedFocusGain(true)
            .setOnAudioFocusChangeListener(audioFocusChangeListener)
            .build()

        val result = am.requestAudioFocus(audioFocusRequest!!)
        Log.d("WebRTCAudio", "Audio focus requested (GAIN), result=$result")
    }

    private fun abandonAudioFocus() {
        // Reached from onDestroy and onTaskRemoved, where a throw propagates
        // into the Service lifecycle callback and takes the process with it —
        // and both of those run precisely when the call is already going wrong.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let {
                runCatching { audioManager?.abandonAudioFocusRequest(it) }
                    .onFailure { e -> Log.w("WebRTCAudio", "abandonAudioFocusRequest threw", e) }
                audioFocusRequest = null
            }
        } else if (legacyFocusHeld) {
            @Suppress("DEPRECATION")
            runCatching { audioManager?.abandonAudioFocus(audioFocusChangeListener) }
                .onFailure { e -> Log.w("WebRTCAudio", "abandonAudioFocus threw", e) }
            legacyFocusHeld = false
        }
        // Session 23 / D-09: undo a duck still in force here too. When we
        // self-abandon the focus (call ended normally) the focus change
        // listener does not fire, and the volume would stay ducked.
        restoreDuckedVolume()
        // The call is over, and this instance may serve the next one. Not in
        // requestAudioFocus: CallActivity.onResume re-requests on every return
        // to the call, and a mute still in force must stay undoable.
        focusLossMute.clear()
    }

    // -----------------------------------------------------------------------
    // Wakelock
    // -----------------------------------------------------------------------

    private fun acquireWakeLock() {
        if (wakeLock != null) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG).apply {
            acquire(60 * 60 * 1000L) // 1 hour max
        }
        Log.d(TAG, "Wakelock acquired")
    }

    private fun releaseWakeLock() {
        wakeLock?.let {
            // `isHeld` is not a sufficient guard: the wakelock carries a 1-hour
            // timeout that can expire between the check and the call, and
            // release() on an already-released lock throws
            // RuntimeException("WakeLock under-locked"). Same lifecycle-callback
            // exposure as abandonAudioFocus above.
            runCatching { if (it.isHeld) it.release() }
                .onFailure { e -> Log.w(TAG, "wakelock release threw", e) }
            wakeLock = null
        }
    }
}
