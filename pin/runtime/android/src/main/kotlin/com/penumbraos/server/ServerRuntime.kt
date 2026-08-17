package com.penumbraos.server

import android.content.Context
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

object ServerRuntime {

    private const val TAG = "PenumbraServer"
    private const val RESTART_DELAY_MS = 10_000L
    private const val IDLE_POLL_MS = 500L

    private val desiredRunning = AtomicBoolean(false)
    private val supervisorStarted = AtomicBoolean(false)
    private val stateLock = Any()

    @Volatile
    private var process: Process? = null

    @Volatile
    private var appContext: Context? = null

    @Volatile
    private var currentConfigPath: String? = null

    @Volatile
    private var currentEsimBridgeToken: String? = null

    @Volatile
    private var stateListener: ((Boolean) -> Unit)? = null

    /**
     * Registers a listener that receives running-state transitions of the
     * supervised server process. The callback is invoked on the supervisor
     * thread; consumers should marshal to their own executor as needed.
     */
    fun setStateListener(listener: ((Boolean) -> Unit)?) {
        stateListener = listener
    }

    private fun notifyState(running: Boolean) {
        try {
            stateListener?.invoke(running)
        } catch (t: Throwable) {
            Log.w(TAG, "State listener threw", t)
        }
    }

    fun start(context: Context, configPath: String, esimBridgeToken: String) {
        desiredRunning.set(true)
        appContext = context.applicationContext
        currentConfigPath = configPath
        currentEsimBridgeToken = EsimBridgeAuthentication.requireValidToken(esimBridgeToken)

        startProcessIfNeeded()
        ensureSupervisorThread()
    }

    fun stop() {
        desiredRunning.set(false)

        val toStop = synchronized(stateLock) {
            val current = process
            process = null
            current
        }

        if (toStop == null) {
            return
        }

        try {
            NativeBridge.stop(toStop)
            Log.w(TAG, "Server runtime stop requested")
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to stop server process", t)
        }
        notifyState(false)
    }

    private fun startProcessIfNeeded() {
        val context = appContext ?: error("Application context unavailable")
        val configPath = currentConfigPath ?: error("Config path unavailable")
        val esimBridgeToken = currentEsimBridgeToken ?: error("eSIM bridge token unavailable")

        synchronized(stateLock) {
            val existing = process
            if (existing?.isAlive == true) {
                Log.w(TAG, "Server runtime already running, ignoring start")
                return
            }

            // The Rust child owns the fetch tracker. Do not let an acknowledgement
            // from its predecessor masquerade as current-session delivery proof.
            FeatureFlagApplyAckRepository.clearForRuntimeRestart()
            process = NativeBridge.start(context, configPath, esimBridgeToken)
            Log.w(TAG, "Server runtime started")
            notifyState(true)
        }
    }

    private fun ensureSupervisorThread() {
        if (!supervisorStarted.compareAndSet(false, true)) {
            return
        }

        Thread({
            supervisorLoop()
        }, "penumbra-server-supervisor").apply {
            isDaemon = true
            uncaughtExceptionHandler = Thread.UncaughtExceptionHandler { thread, error ->
                Log.e(TAG, "Uncaught on ${thread.name}", error)
                supervisorStarted.set(false)
            }
            start()
        }
    }

    private fun supervisorLoop() {
        while (true) {
            try {
                if (!desiredRunning.get()) {
                    Thread.sleep(IDLE_POLL_MS)
                    continue
                }

                val proc = synchronized(stateLock) { process }
                if (proc == null) {
                    try {
                        startProcessIfNeeded()
                    } catch (t: Throwable) {
                        Log.e(TAG, "Failed to start server process", t)
                        Thread.sleep(RESTART_DELAY_MS)
                    }
                    continue
                }

                val exitCode = proc.waitFor()
                synchronized(stateLock) {
                    if (process === proc) {
                        process = null
                    }
                }
                Log.w(TAG, "Server process exited with code $exitCode")
                notifyState(false)

                if (desiredRunning.get()) {
                    Thread.sleep(RESTART_DELAY_MS)
                }
            } catch (t: Throwable) {
                Log.e(TAG, "Supervisor loop failure", t)
                Thread.sleep(RESTART_DELAY_MS)
            }
        }
    }
}
