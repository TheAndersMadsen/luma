package com.penumbraos.hook

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.os.Parcel
import android.os.ParcelFileDescriptor
import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.io.BufferedOutputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileWriter
import java.io.IOException
import java.nio.charset.Charset
import java.nio.file.Files
import java.util.IdentityHashMap
import java.util.LinkedHashMap
import java.util.UUID
import java.util.WeakHashMap
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.regex.Pattern
import kotlin.math.ceil
import com.penumbraos.ipc.contract.PenumbraIpcContract
import com.penumbraos.stockaibus.contract.TierASymbols

/**
 * Mirrors stock ActivityTracker writes into the app-private Penumbra history store.
 *
 * The Ironman process is allowed to create and write its fitness files, but Android's SELinux
 * policy deliberately does not let the shared system UID reopen those files for reading. The
 * previous post-stop export therefore failed even though ActivityTracker had completed normally.
 * This hook stays on the already-authorized producer side instead: it observes only the stock
 * FileSystemWrapper methods and only writers created for the three exact ActivityTracker paths.
 * Successful String writes are copied into a small non-blocking queue and drained through an
 * anonymous pipe owned by FitnessBridgeService. No Ironman file is ever reopened.
 *
 * Mirroring is fail-closed and observational. Queue pressure, a bridge failure, a malformed path,
 * or a size-limit violation aborts only the history copy; it never blocks or changes the result of
 * a stock fitness write/start/stop call.
 */
object FitnessHistoryHooks {
    private const val TAG = "PenumbraHook"
    private const val TRACKER_CLASS = "humane.system.fitness.ActivityTracker"
    private const val FILE_SYSTEM_CLASS =
        "humane.system.fitness.filesystem.implementations.FileSystemWrapper"
    private const val CENTRAL_ACTION_HANDLER_CLASS =
        "humaneinternal.system.intent.CentralActionHandler"
    private const val REGEX_ENGINE_CLASS =
        "humaneinternal.system.intent.interpreters.regex.RegexIntentEngine"
    private const val ACTION_UTILS_CLASS = "humaneinternal.system.utils.ActionUtils"
    private const val ACTION_CONTENT_CLASS = "humane.aibus.SynapseActionContent"
    private const val SCHEMA_CATALOG_CLASS = "humaneinternal.system.concierge.SchemaCatalog"
    private const val STOP_TRACKER_ACTION_CLASS =
        "humaneinternal.system.intent.actions.fitness.StopActivityTrackerAction"
    private const val FEATURE_FLAG_MANAGER_CLASS = "humaneinternal.featureflag.FeatureFlagManager"
    private const val FEATURE_FLAG_ENUM_CLASS =
        "humaneinternal.featureflag.FeatureFlagManager\$Feature"
    private const val FITNESS_TRACKER_FEATURE = "FITNESS_TRACKER_ENABLED"
    private const val BUG_REPORTER_CLASS = "humaneinternal.bugreport.BugReporter"
    private const val NARRATION_OBSERVATION_CLASS =
        "humaneinternal.system.intent.observations.system.NarrationObservation"
    private const val FITNESS_BUG_REPORT_DESCRIPTION = "Fitness tracking session data"
    private const val STOP_TRACKER_ACTION = TierASymbols.NativeActions.STOP_ACTIVITY_TRACKER
    private const val STOP_TRACKER_REGEX =
        "(stop|end|finish)\\s*(tracking\\s*|recording\\s*)?(my\\s*|a\\s*|an\\s*|the\\s*|this\\s*)?\\s*((activity|fitness)\\s*(tracker|tracking)|run|bike\\s*(ride|workout)?|ride|walk|hike|workout|activity|activities)$"
    private val stopTrackerPattern = Pattern.compile(STOP_TRACKER_REGEX)

    private val stateLock = Any()
    private val trackerSessions = WeakHashMap<Any, FitnessSessionCapture>()
    private val startAttemptTimes = WeakHashMap<Any, Long>()
    private val startAttemptCaptures = WeakHashMap<Any, MutableSet<FitnessSessionCapture>>()
    private val capturesByDirectory = HashMap<String, FitnessSessionCapture>()
    private val writerBindings = IdentityHashMap<FileWriter, WriterBinding>()
    private val startAttemptOwner = ThreadLocal<Any>()
    private val stopResolveDepth = ThreadLocal<Int>()
    private val fitnessBugReportSuppressed = ThreadLocal<Boolean>()
    private val producerCharset = Charset.defaultCharset()
    private val producerMaxBytesPerChar =
        ceil(producerCharset.newEncoder().maxBytesPerChar().toDouble()).toLong().coerceAtLeast(1L)
    private val exporter = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "penumbra-fitness-export").apply { isDaemon = true }
    }

    fun install(cl: ClassLoader) {
        installStopRecoveryRouting(cl)
        installStopSafety(cl)
        try {
            installProducerMirror(cl)
            installTrackerLifecycle(cl)
            Log.w(TAG, "  FitnessHistoryHooks installed on the stock fitness producer")
        } catch (error: Throwable) {
            Log.e(TAG, "  FitnessHistoryHooks install failed: ${error.javaClass.simpleName}")
        }
    }

    /**
     * Keep only the cleanup half of stock fitness routing reachable when the live base gate is
     * disabled. Firmware snapshots the gate while constructing both its regex engine and schema
     * catalogs, so the resolve-scoped override below is otherwise unreachable after a restart.
     * StartActivityTracker is deliberately not repaired here and remains fully feature-gated.
     */
    private fun installStopRecoveryRouting(cl: ClassLoader) {
        var installed = 0
        if (installStopRegexRecovery(cl)) installed++
        if (installStopSchemaRecovery(cl)) installed++
        Log.w(TAG, "  Fitness stop recovery routing installed $installed/2 stock gates")
    }

    private fun installStopRegexRecovery(cl: ClassLoader): Boolean = try {
        val engineClass = cl.loadClass(REGEX_ENGINE_CLASS)
        val process = engineClass.getDeclaredMethod(
            "process",
            String::class.java,
        ).apply { isAccessible = true }
        val compiledRegexes = engineClass.getDeclaredField(
            "compiledRegexes",
        ).apply { isAccessible = true }
        val groupNamesByRegex = engineClass.getDeclaredField(
            "groupNamesByRegex",
        ).apply { isAccessible = true }

        XposedBridge.hookMethod(process, object : XC_MethodHook() {
            override fun beforeHookedMethod(param: MethodHookParam) {
                val query = param.args.getOrNull(0) as? String ?: return
                if (!isExactFitnessStopPhrase(query)) return
                try {
                    @Suppress("UNCHECKED_CAST")
                    val compiled = compiledRegexes.get(param.thisObject)
                        as? MutableMap<String, List<Pattern>> ?: return
                    @Suppress("UNCHECKED_CAST")
                    val groups = groupNamesByRegex.get(param.thisObject)
                        as? MutableMap<Pattern, List<String>> ?: return
                    if (ensureFitnessStopRegex(compiled, groups)) {
                        Log.w(TAG, "  Restored stock fitness stop regex for cleanup")
                    }
                } catch (error: Throwable) {
                    Log.e(TAG, "  Fitness stop regex repair failed: ${error.javaClass.simpleName}")
                }
            }
        })
        true
    } catch (error: Throwable) {
        Log.e(TAG, "  Fitness stop regex hook failed: ${error.javaClass.simpleName}")
        false
    }

    private fun installStopSchemaRecovery(cl: ClassLoader): Boolean = try {
        val actionContentClass = cl.loadClass(ACTION_CONTENT_CLASS)
        val contentAction = actionContentClass.getDeclaredMethod(
            "getAction",
        ).apply { isAccessible = true }
        val actionUtilsClass = cl.loadClass(ACTION_UTILS_CLASS)
        val createCatalog = actionUtilsClass.getDeclaredMethod(
            "createCentralSchemaCatalog",
        ).apply { isAccessible = true }
        val isValidAction = actionUtilsClass.getDeclaredMethod(
            "isValidAction",
            actionContentClass,
        ).apply { isAccessible = true }
        val catalogClass = cl.loadClass(SCHEMA_CATALOG_CLASS)
        val containsSchema = catalogClass.getDeclaredMethod(
            "containsSchema",
            String::class.java,
        ).apply { isAccessible = true }
        val addSchema = catalogClass.getDeclaredMethod(
            "add",
            Class::class.java,
        ).apply { isAccessible = true }
        val stopActionClass = cl.loadClass(STOP_TRACKER_ACTION_CLASS)

        XposedBridge.hookMethod(createCatalog, object : XC_MethodHook() {
            override fun afterHookedMethod(param: MethodHookParam) {
                if (param.throwable != null) return
                val catalog = param.result ?: return
                try {
                    if (ensureFitnessStopSchema(
                            catalog,
                            containsSchema = {
                                containsSchema.invoke(catalog, STOP_TRACKER_ACTION) as? Boolean == true
                            },
                            addSchema = { addSchema.invoke(catalog, stopActionClass) },
                        )
                    ) {
                        Log.w(TAG, "  Restored stock fitness stop schema for cleanup")
                    }
                } catch (error: Throwable) {
                    Log.e(TAG, "  Fitness stop schema repair failed: ${error.javaClass.simpleName}")
                }
            }
        })
        // If ActionUtils initialized before hook installation, its private static catalog cannot
        // be safely rebuilt. Preserve only the exact Stop action at its public validation seam.
        XposedBridge.hookMethod(isValidAction, object : XC_MethodHook() {
            override fun beforeHookedMethod(param: MethodHookParam) {
                val content = param.args.getOrNull(0) ?: return
                val actionName = runCatching { contentAction.invoke(content) as? String }.getOrNull()
                if (actionName == STOP_TRACKER_ACTION) param.result = true
            }
        })
        true
    } catch (error: Throwable) {
        Log.e(TAG, "  Fitness stop schema hook failed: ${error.javaClass.simpleName}")
        false
    }

    private fun installProducerMirror(cl: ClassLoader) {
        val fileSystem = cl.loadClass(FILE_SYSTEM_CLASS)
        val createWriter = fileSystem.getDeclaredMethod(
            "createFileWriter",
            String::class.java,
        ).apply { isAccessible = true }
        val writeToFile = fileSystem.getDeclaredMethod(
            "writeToFile",
            FileWriter::class.java,
            String::class.java,
        ).apply { isAccessible = true }

        XposedBridge.hookMethod(createWriter, object : XC_MethodHook() {
            override fun afterHookedMethod(param: MethodHookParam) {
                if (param.throwable != null) return
                val path = param.args.getOrNull(0) as? String ?: return
                val writer = param.result as? FileWriter ?: return
                registerStockWriter(path, writer)
            }
        })
        XposedBridge.hookMethod(writeToFile, object : XC_MethodHook() {
            override fun afterHookedMethod(param: MethodHookParam) {
                // Mirror only a write that the stock implementation completed successfully.
                if (param.throwable != null) return
                val writer = param.args.getOrNull(0) as? FileWriter ?: return
                val content = param.args.getOrNull(1) as? String ?: return
                mirrorSuccessfulWrite(writer, content)
            }
        })
    }

    private fun installTrackerLifecycle(cl: ClassLoader) {
        val tracker = cl.loadClass(TRACKER_CLASS)
        val burstField = tracker.getDeclaredField("mBurstDirectory").apply { isAccessible = true }
        val start = tracker.getDeclaredMethod("start").apply { isAccessible = true }
        val stop = tracker.getDeclaredMethod("stop").apply { isAccessible = true }

        XposedBridge.hookMethod(start, object : XC_MethodHook() {
            override fun beforeHookedMethod(param: MethodHookParam) {
                synchronized(stateLock) {
                    startAttemptTimes[param.thisObject] = System.currentTimeMillis()
                    startAttemptCaptures[param.thisObject] = LinkedHashSet()
                }
                startAttemptOwner.set(param.thisObject)
            }

            override fun afterHookedMethod(param: MethodHookParam) {
                startAttemptOwner.remove()
                val (startedAtMs, candidates) = synchronized(stateLock) {
                    (startAttemptTimes.remove(param.thisObject) ?: System.currentTimeMillis()) to
                        startAttemptCaptures.remove(param.thisObject).orEmpty().toList()
                }
                val directory = stockBurstDirectory(burstField, param.thisObject)
                val capture = directory?.let { synchronized(stateLock) { capturesByDirectory[it] } }
                candidates.filter { it !== capture }.forEach {
                    abortAndDiscard(it, "stock start did not select this fitness writer set")
                }
                if (capture == null) return

                when {
                    param.throwable != null || isError(param.result) ->
                        abortAndDiscard(capture, "stock start failed")
                    isSuccess(param.result) -> {
                        if (capture.markStarted(startedAtMs)) {
                            synchronized(stateLock) { trackerSessions[param.thisObject] = capture }
                            exporter.execute { exportStream(capture) }
                            Log.i(TAG, "  Fitness history producer stream armed")
                        } else {
                            abortAndDiscard(capture, "stock start stream was incomplete")
                        }
                    }
                }
            }
        })

        XposedBridge.hookMethod(stop, object : XC_MethodHook() {
            override fun afterHookedMethod(param: MethodHookParam) {
                val capture = synchronized(stateLock) {
                    trackerSessions.remove(param.thisObject)
                } ?: return
                if (param.throwable == null && isSuccess(param.result)) {
                    discardBindings(capture)
                    if (!capture.complete(System.currentTimeMillis())) {
                        capture.abort("stock stop produced an incomplete stream")
                    }
                } else if (param.throwable != null || isError(param.result)) {
                    abortAndDiscard(capture, "stock stop failed")
                } else {
                    // NO_CHANGE cannot normally occur for an armed capture. Preserve the capture
                    // in case a firmware variant reports it transiently while still running.
                    synchronized(stateLock) { trackerSessions[param.thisObject] = capture }
                }
            }
        })
    }

    private fun registerStockWriter(path: String, writer: FileWriter) {
        // ActivityTracker creates all three writers synchronously inside start(). Requiring that
        // exact lifecycle prevents an unrelated FileSystemWrapper caller from creating a capture
        // that could remain strongly reachable without a matching tracker session.
        val tracker = startAttemptOwner.get() ?: return
        val source = validatedProducerPath(path) ?: return
        val capture = synchronized(stateLock) {
            val candidates = startAttemptCaptures[tracker] ?: return@synchronized null
            val current = capturesByDirectory[source.directory]
                ?: FitnessSessionCapture(source.sessionId, source.directory).also {
                    capturesByDirectory[source.directory] = it
                }
            if (!current.registerFile(source.filename)) {
                current.abort("duplicate or late stock fitness writer")
                discardBindingsLocked(current)
                return@synchronized null
            }
            writerBindings[writer] = WriterBinding(current, source.filename)
            candidates.add(current)
            current
        }
        if (capture == null) {
            Log.w(TAG, "  Fitness mirror rejected an unexpected writer lifecycle")
        }
    }

    private fun mirrorSuccessfulWrite(writer: FileWriter, content: String) {
        val binding = synchronized(stateLock) { writerBindings[writer] } ?: return
        // Do this before encoding: a firmware regression must not make the observational mirror
        // allocate a String-sized byte array that is larger than its entire pending-memory budget.
        if (!binding.capture.canEncode(
                binding.filename,
                content.length,
                producerMaxBytesPerChar,
            )
        ) {
            abortAndDiscard(binding.capture, "fitness mirror pre-encode bound exceeded")
            Log.w(TAG, "  Fitness history mirror rejected an oversized stock write")
            return
        }
        val bytes = content.toByteArray(producerCharset)
        if (!binding.capture.append(binding.filename, bytes)) {
            abortAndDiscard(binding.capture, "fitness mirror queue or size limit exceeded")
            Log.w(TAG, "  Fitness history mirror aborted without affecting stock tracking")
        }
    }

    private fun validatedProducerPath(path: String): ProducerPath? {
        val context = currentApplication() ?: return null
        return try {
            val candidate = File(path)
            if (!candidate.isAbsolute || candidate.name !in FitnessMirrorContract.ALLOWED_FILENAMES ||
                Files.isSymbolicLink(candidate.toPath())
            ) return null
            val directory = candidate.parentFile?.canonicalFile ?: return null
            val expectedRoot = File(context.filesDir, "activity_data").canonicalFile
            if (directory.parentFile?.canonicalFile != expectedRoot ||
                Files.isSymbolicLink(directory.toPath())
            ) return null
            val sessionId = canonicalSessionId(directory.name)
            ProducerPath(sessionId, directory.absolutePath, candidate.name)
        } catch (_: Throwable) {
            null
        }
    }

    private fun stockBurstDirectory(field: java.lang.reflect.Field, tracker: Any): String? =
        runCatching {
            val raw = when (val value = field.get(tracker)) {
                is File -> value.absolutePath
                is String -> value
                else -> null
            } ?: return@runCatching null
            val directory = File(raw).canonicalFile
            canonicalSessionId(directory.name)
            val context = currentApplication() ?: return@runCatching null
            if (directory.parentFile?.canonicalFile !=
                File(context.filesDir, "activity_data").canonicalFile
            ) return@runCatching null
            directory.absolutePath
        }.getOrNull()

    private fun exportStream(capture: FitnessSessionCapture) {
        val context = currentApplication()
        if (context == null) {
            abortAndDiscard(capture, "application context unavailable")
            return
        }
        val connected = CountDownLatch(1)
        var remote: IBinder? = null
        var disconnected = false
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
                remote = service
                connected.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                disconnected = true
                connected.countDown()
            }

            override fun onNullBinding(name: ComponentName?) {
                disconnected = true
                connected.countDown()
            }
        }
        var bound = false
        var binder: IBinder? = null
        var pipe: ParcelFileDescriptor? = null
        var terminal: FitnessStreamEvent? = null
        try {
            bound = context.bindService(
                Intent().setComponent(
                    ComponentName(
                        FitnessMirrorContract.BRIDGE_PACKAGE,
                        FitnessMirrorContract.BRIDGE_CLASS,
                    ),
                ),
                connection,
                Context.BIND_AUTO_CREATE,
            )
            if (!bound || !connected.await(FitnessMirrorContract.BIND_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                throw IOException("Fitness bridge connection timed out")
            }
            binder = remote
            if (disconnected || binder == null || !binder.isBinderAlive) {
                throw IOException("Fitness bridge is unavailable")
            }

            pipe = beginStream(binder, capture)
                ?: throw IOException("Fitness bridge is at capacity")
            val output = DataOutputStream(
                BufferedOutputStream(ParcelFileDescriptor.AutoCloseOutputStream(pipe)),
            )
            pipe = null // AutoCloseOutputStream now owns it.
            try {
                output.writeInt(FitnessMirrorContract.STREAM_MAGIC)
                output.writeInt(FitnessMirrorContract.STREAM_VERSION)
                while (true) {
                    when (val event = capture.take()) {
                        is FitnessStreamEvent.Frame -> {
                            output.writeInt(event.fileId)
                            output.writeInt(event.bytes.size)
                            output.write(event.bytes)
                        }
                        is FitnessStreamEvent.Complete,
                        is FitnessStreamEvent.Abort,
                        -> {
                            terminal = event
                            break
                        }
                    }
                }
                output.flush()
            } finally {
                // Clean EOF is part of the protocol. FINISH is sent only after the pipe closes.
                runCatching { output.close() }
            }

            when (val event = terminal) {
                is FitnessStreamEvent.Complete -> {
                    if (!finishStream(binder, capture, event)) {
                        throw IOException("Fitness bridge rejected the completed stream")
                    }
                    Log.i(TAG, "  Fitness session handed to bounded history importer")
                }
                is FitnessStreamEvent.Abort -> abortRemote(binder, capture.sessionId)
                else -> throw IOException("Fitness producer stream ended without a terminal event")
            }
        } catch (error: Throwable) {
            capture.abort("fitness bridge failure")
            binder?.takeIf(IBinder::isBinderAlive)?.let {
                runCatching { abortRemote(it, capture.sessionId) }
            }
            Log.w(TAG, "  Fitness history stream failed: ${error.javaClass.simpleName}")
        } finally {
            runCatching { pipe?.close() }
            discardBindings(capture)
            if (bound) runCatching { context.unbindService(connection) }
        }
    }

    private fun beginStream(
        binder: IBinder,
        capture: FitnessSessionCapture,
    ): ParcelFileDescriptor? {
        val files = capture.registeredFiles()
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        return try {
            data.writeInterfaceToken(FitnessMirrorContract.BRIDGE_DESCRIPTOR)
            data.writeString(capture.sessionId)
            data.writeLong(capture.startedAtMs)
            data.writeInt(files.size)
            files.forEach(data::writeString)
            if (!binder.transact(FitnessMirrorContract.TRANSACTION_BEGIN, data, reply, 0)) {
                throw IOException("Fitness bridge rejected BEGIN")
            }
            reply.readException()
            if (reply.readInt() != 1) return null
            require(reply.readInt() == 1) { "Fitness stream descriptor is missing" }
            ParcelFileDescriptor.CREATOR.createFromParcel(reply)
        } finally {
            data.recycle()
            reply.recycle()
        }
    }

    private fun finishStream(
        binder: IBinder,
        capture: FitnessSessionCapture,
        completion: FitnessStreamEvent.Complete,
    ): Boolean {
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        return try {
            data.writeInterfaceToken(FitnessMirrorContract.BRIDGE_DESCRIPTOR)
            data.writeString(capture.sessionId)
            data.writeLong(completion.stoppedAtMs)
            data.writeInt(completion.files.size)
            completion.files.forEach { file ->
                data.writeString(file.filename)
                data.writeLong(file.sizeBytes)
            }
            if (!binder.transact(FitnessMirrorContract.TRANSACTION_FINISH, data, reply, 0)) {
                throw IOException("Fitness bridge rejected FINISH")
            }
            reply.readException()
            reply.readInt() == 1
        } finally {
            data.recycle()
            reply.recycle()
        }
    }

    private fun abortRemote(binder: IBinder, sessionId: String): Boolean {
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        return try {
            data.writeInterfaceToken(FitnessMirrorContract.BRIDGE_DESCRIPTOR)
            data.writeString(sessionId)
            if (!binder.transact(FitnessMirrorContract.TRANSACTION_ABORT, data, reply, 0)) {
                return false
            }
            reply.readException()
            reply.readInt() == 1
        } finally {
            data.recycle()
            reply.recycle()
        }
    }

    private fun abortAndDiscard(capture: FitnessSessionCapture, reason: String) {
        capture.abort(reason)
        discardBindings(capture)
    }

    private fun discardBindings(capture: FitnessSessionCapture) {
        synchronized(stateLock) { discardBindingsLocked(capture) }
    }

    private fun discardBindingsLocked(capture: FitnessSessionCapture) {
        capturesByDirectory.entries.removeAll { it.value === capture }
        trackerSessions.entries.removeAll { it.value === capture }
        writerBindings.entries.removeAll { it.value.capture === capture }
    }

    /**
     * Preserve the stock StopActivityTrackerAction implementation when the operator disables
     * new fitness sessions while one is already active. Stock gates both start() and stop() on
     * FITNESS_TRACKER_ENABLED, which can otherwise leave the sensor writers running with no
     * voice action capable of closing them.
     */
    private fun installStopSafety(cl: ClassLoader) {
        try {
            val stopAction = cl.loadClass(STOP_TRACKER_ACTION_CLASS)
            val resolveStop = cl.loadClass(CENTRAL_ACTION_HANDLER_CLASS)
                .getDeclaredMethod("resolve", stopAction)
                .apply { isAccessible = true }
            val feature = cl.loadClass(FEATURE_FLAG_ENUM_CLASS)
            val getBoolValue = cl.loadClass(FEATURE_FLAG_MANAGER_CLASS)
                .getDeclaredMethod("getBoolValue", feature)
                .apply { isAccessible = true }
            val submitBugReport = cl.loadClass(BUG_REPORTER_CLASS)
                .getDeclaredMethod("submitAsync", String::class.java)
                .apply { isAccessible = true }
            // Narration is cosmetic. Keep the privacy interception installable even if a future
            // firmware changes this observation constructor while retaining the upload call.
            val narrationRepair = runCatching {
                stopAction.getMethod("identifier").apply { isAccessible = true } to
                    cl.loadClass(NARRATION_OBSERVATION_CLASS)
                        .getDeclaredConstructor(UUID::class.java, String::class.java)
                        .apply { isAccessible = true }
            }.onFailure { error ->
                Log.w(
                    TAG,
                    "  Fitness stop narration repair unavailable: ${error.javaClass.simpleName}",
                )
            }.getOrNull()

            XposedBridge.hookMethod(resolveStop, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val depth = (stopResolveDepth.get() ?: 0) + 1
                    if (depth == 1) fitnessBugReportSuppressed.remove()
                    stopResolveDepth.set(depth)
                }

                override fun afterHookedMethod(param: MethodHookParam) {
                    if (param.throwable == null && fitnessBugReportSuppressed.get() == true &&
                        narrationRepair != null
                    ) {
                        try {
                            val (actionIdentifier, narrationObservation) = narrationRepair
                            val identifier = actionIdentifier.invoke(param.args.getOrNull(0)) as UUID
                            param.result = narrationObservation.newInstance(
                                identifier,
                                "Activity tracking stopped.",
                            )
                        } catch (error: Throwable) {
                            // The privacy boundary is the submitAsync interception below. If this
                            // cosmetic narration repair fails, preserve the successful stock stop.
                            Log.e(
                                TAG,
                                "  Fitness stop narration repair failed: ${error.javaClass.simpleName}",
                            )
                        }
                    }
                    val remaining = (stopResolveDepth.get() ?: 1) - 1
                    if (remaining > 0) {
                        stopResolveDepth.set(remaining)
                    } else {
                        stopResolveDepth.remove()
                        fitnessBugReportSuppressed.remove()
                    }
                }
            })
            XposedBridge.hookMethod(getBoolValue, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    val featureName = (param.args.getOrNull(0) as? Enum<*>)?.name
                    if (param.throwable == null && param.result == false &&
                        shouldBypassFitnessStopGate(stopResolveDepth.get() ?: 0, featureName)
                    ) {
                        param.result = true
                        Log.w(TAG, "  Allowing stock fitness stop while new sessions are disabled")
                    }
                }
            })
            XposedBridge.hookMethod(submitBugReport, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val description = param.args.getOrNull(0) as? String
                    if (!shouldSuppressFitnessBugReport(
                            stopResolveDepth.get() ?: 0,
                            description,
                        )
                    ) return
                    fitnessBugReportSuppressed.set(true)
                    param.result = CompletableFuture.completedFuture(null)
                    Log.w(TAG, "  Suppressed stock fitness Memfault/Bort upload")
                }
            })
            Log.w(TAG, "  Fitness stop safety installed on stock CentralActionHandler")
        } catch (error: Throwable) {
            Log.e(TAG, "  Fitness stop safety install failed: ${error.javaClass.simpleName}")
        }
    }

    internal fun shouldBypassFitnessStopGate(
        stopDepth: Int,
        featureName: String?,
    ): Boolean = stopDepth > 0 && featureName == FITNESS_TRACKER_FEATURE

    internal fun shouldSuppressFitnessBugReport(
        stopDepth: Int,
        description: String?,
    ): Boolean = stopDepth > 0 && description == FITNESS_BUG_REPORT_DESCRIPTION

    /** RegexIntentEngine receives Interpreter.normalizeUtterance output. */
    internal fun isExactFitnessStopPhrase(query: String): Boolean =
        stopTrackerPattern.matcher(query).matches()

    internal fun ensureFitnessStopRegex(
        compiledRegexes: MutableMap<String, List<Pattern>>,
        groupNamesByRegex: MutableMap<Pattern, List<String>>,
    ): Boolean = synchronized(compiledRegexes) {
        val existing = compiledRegexes[STOP_TRACKER_ACTION].orEmpty()
        val stopPattern = existing.firstOrNull { it.pattern() == STOP_TRACKER_REGEX }
            ?: Pattern.compile(STOP_TRACKER_REGEX)
        var changed = false
        if (stopPattern !in existing) {
            compiledRegexes[STOP_TRACKER_ACTION] = existing + stopPattern
            changed = true
        }
        if (!groupNamesByRegex.containsKey(stopPattern)) {
            groupNamesByRegex[stopPattern] = emptyList()
            changed = true
        }
        changed
    }

    internal fun ensureFitnessStopSchema(
        catalogLock: Any,
        containsSchema: () -> Boolean,
        addSchema: () -> Unit,
    ): Boolean = synchronized(catalogLock) {
        if (containsSchema()) {
            false
        } else {
            addSchema()
            true
        }
    }

    private fun isSuccess(value: Any?): Boolean =
        (value as? Enum<*>)?.name?.startsWith("SUCCESS_") == true

    private fun isError(value: Any?): Boolean = (value as? Enum<*>)?.name == "ERROR"

    private fun canonicalSessionId(value: String): String {
        require(UUID.fromString(value).toString() == value)
        return value
    }

    private fun currentApplication(): Context? = runCatching {
        Class.forName("android.app.ActivityThread")
            .getMethod("currentApplication")
            .invoke(null) as? Context
    }.getOrNull()

    private data class ProducerPath(
        val sessionId: String,
        val directory: String,
        val filename: String,
    )

    private data class WriterBinding(
        val capture: FitnessSessionCapture,
        val filename: String,
    )
}

internal object FitnessMirrorContract {
    const val BRIDGE_PACKAGE = "com.penumbraos.server"
    const val BRIDGE_CLASS = "com.penumbraos.server.FitnessBridgeService"
    const val BRIDGE_DESCRIPTOR = TierASymbols.Binder.PenumbraFitness.DESCRIPTOR
    const val TRANSACTION_BEGIN = PenumbraIpcContract.Fitness.TRANSACTION_BEGIN_SESSION
    const val TRANSACTION_FINISH = PenumbraIpcContract.Fitness.TRANSACTION_FINISH_SESSION
    const val TRANSACTION_ABORT = PenumbraIpcContract.Fitness.TRANSACTION_ABORT_SESSION
    const val BIND_TIMEOUT_MS = 3_000L

    const val STREAM_MAGIC = 0x50464E32
    const val STREAM_VERSION = 1
    const val MAX_FRAME_BYTES = 64 * 1024
    const val MAX_PENDING_BYTES = 1L * 1024 * 1024
    const val MAX_QUEUED_FRAMES = 4_096

    const val SUMMARY = "activity-tracking-summary.csv"
    const val LOCATION = "activity-tracking-location-data.gpx"
    const val SENSOR = "activity-tracking-sensor-data.csv"
    const val SUMMARY_ID = 1
    const val LOCATION_ID = 2
    const val SENSOR_ID = 3
    const val MAX_SUMMARY_BYTES = 2L * 1024 * 1024
    const val MAX_LOCATION_BYTES = 16L * 1024 * 1024
    const val MAX_SENSOR_BYTES = 256L * 1024 * 1024
    const val MAX_SESSION_BYTES = MAX_SUMMARY_BYTES + MAX_LOCATION_BYTES + MAX_SENSOR_BYTES

    val REQUIRED_FILENAMES = setOf(SUMMARY, LOCATION)
    val ALLOWED_FILENAMES = REQUIRED_FILENAMES + SENSOR
    val FILE_ID_BY_NAME = mapOf(SUMMARY to SUMMARY_ID, LOCATION to LOCATION_ID, SENSOR to SENSOR_ID)

    fun maxBytes(filename: String): Long = when (filename) {
        SUMMARY -> MAX_SUMMARY_BYTES
        LOCATION -> MAX_LOCATION_BYTES
        SENSOR -> MAX_SENSOR_BYTES
        else -> 0L
    }
}

internal data class FitnessMirroredFile(
    val filename: String,
    val sizeBytes: Long,
)

internal sealed class FitnessStreamEvent {
    data class Frame(val fileId: Int, val bytes: ByteArray) : FitnessStreamEvent()
    data class Complete(
        val stoppedAtMs: Long,
        val files: List<FitnessMirroredFile>,
    ) : FitnessStreamEvent()
    data class Abort(val reason: String) : FitnessStreamEvent()
}

/** Small producer queue; stock writes never wait for bridge I/O. */
internal class FitnessSessionCapture(
    val sessionId: String,
    val directory: String,
    private val maxPendingBytes: Long = FitnessMirrorContract.MAX_PENDING_BYTES,
    private val maxFrameBytes: Int = FitnessMirrorContract.MAX_FRAME_BYTES,
    maxQueuedFrames: Int = FitnessMirrorContract.MAX_QUEUED_FRAMES,
) {
    private val queue = ArrayBlockingQueue<FitnessStreamEvent>(maxQueuedFrames + 1)
    private val sizes = LinkedHashMap<String, Long>()
    private var pendingBytes = 0L
    private var totalBytes = 0L
    private var state = State.CAPTURING

    @Volatile
    var startedAtMs: Long = 0L
        private set

    @Synchronized
    fun registerFile(filename: String): Boolean {
        if (state != State.CAPTURING || filename !in FitnessMirrorContract.ALLOWED_FILENAMES ||
            sizes.containsKey(filename)
        ) return false
        sizes[filename] = 0L
        return true
    }

    @Synchronized
    fun registeredFiles(): List<String> = sizes.keys.toList()

    @Synchronized
    fun markStarted(timestampMs: Long): Boolean {
        if (state != State.CAPTURING || timestampMs <= 0 ||
            !sizes.keys.containsAll(FitnessMirrorContract.REQUIRED_FILENAMES)
        ) return false
        startedAtMs = timestampMs
        state = State.STREAMING
        return true
    }

    @Synchronized
    fun append(filename: String, bytes: ByteArray): Boolean {
        if (state != State.CAPTURING && state != State.STREAMING) return false
        val current = sizes[filename] ?: return false
        if (bytes.isEmpty()) return true
        val nextFileSize = runCatching { Math.addExact(current, bytes.size.toLong()) }.getOrNull()
            ?: return failLocked("fitness file size overflow")
        val nextTotal = runCatching { Math.addExact(totalBytes, bytes.size.toLong()) }.getOrNull()
            ?: return failLocked("fitness session size overflow")
        val frameCount = (bytes.size + maxFrameBytes - 1) / maxFrameBytes
        if (nextFileSize > FitnessMirrorContract.maxBytes(filename) ||
            nextTotal > FitnessMirrorContract.MAX_SESSION_BYTES ||
            bytes.size.toLong() > maxPendingBytes - pendingBytes ||
            queue.remainingCapacity() <= frameCount
        ) return failLocked("fitness producer bounds exceeded")

        var offset = 0
        while (offset < bytes.size) {
            val end = minOf(bytes.size, offset + maxFrameBytes)
            check(queue.offer(
                FitnessStreamEvent.Frame(
                    checkNotNull(FitnessMirrorContract.FILE_ID_BY_NAME[filename]),
                    bytes.copyOfRange(offset, end),
                ),
            ))
            offset = end
        }
        sizes[filename] = nextFileSize
        totalBytes = nextTotal
        pendingBytes += bytes.size
        return true
    }

    /** Conservative allocation gate evaluated before String.toByteArray(). */
    @Synchronized
    fun canEncode(filename: String, characterCount: Int, maxBytesPerChar: Long): Boolean {
        if ((state != State.CAPTURING && state != State.STREAMING) || characterCount < 0 ||
            maxBytesPerChar <= 0
        ) return false
        val current = sizes[filename] ?: return false
        val upperBound = runCatching {
            Math.multiplyExact(characterCount.toLong(), maxBytesPerChar)
        }.getOrNull() ?: return false
        val frameCount = if (upperBound == 0L) 0L else
            (upperBound + maxFrameBytes - 1L) / maxFrameBytes
        return upperBound <= maxPendingBytes - pendingBytes &&
            upperBound <= FitnessMirrorContract.maxBytes(filename) - current &&
            upperBound <= FitnessMirrorContract.MAX_SESSION_BYTES - totalBytes &&
            frameCount < queue.remainingCapacity().toLong()
    }

    @Synchronized
    fun complete(stoppedAtMs: Long): Boolean {
        if (state != State.STREAMING || stoppedAtMs < startedAtMs ||
            !sizes.keys.containsAll(FitnessMirrorContract.REQUIRED_FILENAMES) ||
            sizes.any { it.value <= 0L }
        ) return false
        state = State.COMPLETE
        return queue.offer(
            FitnessStreamEvent.Complete(
                stoppedAtMs,
                sizes.map { FitnessMirroredFile(it.key, it.value) },
            ),
        )
    }

    @Synchronized
    fun abort(reason: String): Boolean {
        if (state == State.COMPLETE || state == State.ABORTED) return false
        return failLocked(reason)
    }

    fun take(): FitnessStreamEvent {
        val event = queue.take()
        if (event is FitnessStreamEvent.Frame) {
            synchronized(this) {
                pendingBytes = (pendingBytes - event.bytes.size).coerceAtLeast(0L)
            }
        }
        return event
    }

    private fun failLocked(reason: String): Boolean {
        state = State.ABORTED
        queue.clear()
        pendingBytes = 0L
        check(queue.offer(FitnessStreamEvent.Abort(reason)))
        return false
    }

    private enum class State { CAPTURING, STREAMING, COMPLETE, ABORTED }
}
