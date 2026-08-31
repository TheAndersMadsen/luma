package com.penumbraos.hook

import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.lang.reflect.Method
import java.lang.reflect.Modifier
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.ArrayDeque
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Emits bounded, content-free proof for a stock Food write and its readback.
 * Stock arguments and results are observed only; no result is replaced.
 */
object FoodRoundTripEvidenceHooks {
    private const val TAG = "PenumbraHook"
    internal const val WRAPPER_CLASS =
        "humane.experience.food.dependency.implementations.FoodServiceWrapper"
    internal const val TRACK_CONTINUATION_CLASS =
        "$WRAPPER_CLASS\$trackFoodItemConsumption\$1"
    internal const val LOOKUP_CONTINUATION_CLASS =
        "$WRAPPER_CLASS\$getFoodItem\$1"
    internal const val READ_CONTINUATION_CLASS =
        "$WRAPPER_CLASS\$getFoodLogSummary\$1"
    internal const val GET_FOOD_ITEM_RESPONSE_CLASS = "humane.aibus.GetFoodItemResponse"
    internal const val FOOD_ITEM_CLASS = "humane.common.food.FoodItem"
    internal const val FOOD_LOG_SUMMARY_CLASS = "humane.common.food.FoodLogSummary"
    internal const val CREATE_RESPONSE_CLASS = "humane.capture.CreateMemoryResponse"
    internal const val CONTINUATION_CLASS = "kotlin.coroutines.Continuation"
    private const val MAX_RECENT_CREATES = 16
    private const val ARM_PROPERTY = "debug.penumbra.food_nonce"
    private const val MAX_ARM_WINDOW_SECONDS = 180L
    private val ARM_PATTERN = Regex("^([0-9a-f]{32}):([0-9]{10})$")
    private val NONCE_PATTERN = Regex("^[0-9a-f]{32}$")
    private val UUID_PATTERN =
        Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    internal data class MethodShape(
        val name: String,
        val returnType: String,
        val parameterTypes: List<String>,
        val isPublic: Boolean,
        val isStatic: Boolean,
    )

    internal data class ActiveArm(val nonce: String, val expiresAtSeconds: Long)
    internal data class PendingEvidence(
        val fingerprint: String,
        val itemToken: String,
        val nonce: String,
        val baselineCount: Int,
    )
    internal data class CreateEvidence(
        val fingerprint: String,
        val itemToken: String,
        val memoryToken: String,
        val nonce: String,
        val baselineCount: Int,
    )

    internal class EvidenceWindow {
        private var activeArm: ActiveArm? = null
        private var baselineCounts: Map<String, Int>? = null
        private val lookupTokens = ArrayDeque<String>()
        private val recentCreates = ArrayDeque<CreateEvidence>()

        @Synchronized
        fun synchronize(arm: ActiveArm?): Boolean {
            if (arm != null && activeArm?.nonce == arm.nonce) {
                activeArm = arm
                return false
            }
            if (arm == activeArm) return false
            activeArm = arm
            baselineCounts = null
            lookupTokens.clear()
            recentCreates.clear()
            return true
        }

        @Synchronized
        fun expire(expected: ActiveArm): Boolean {
            if (activeArm != expected) return false
            activeArm = null
            baselineCounts = null
            lookupTokens.clear()
            recentCreates.clear()
            return true
        }

        @Synchronized
        fun recordLookup(nonce: String, itemToken: String) {
            if (activeArm?.nonce != nonce) return
            lookupTokens.addLast(itemToken)
            while (lookupTokens.size > MAX_RECENT_CREATES) lookupTokens.removeFirst()
        }

        @Synchronized
        fun consumeLookup(nonce: String, itemToken: String): Boolean {
            if (activeArm?.nonce != nonce) return false
            return lookupTokens.removeFirstOccurrence(itemToken)
        }

        @Synchronized
        fun recordBaseline(nonce: String, counts: Map<String, Int>): Boolean {
            if (activeArm?.nonce != nonce || baselineCounts != null || recentCreates.isNotEmpty()) {
                return false
            }
            baselineCounts = counts.toMap()
            return true
        }

        @Synchronized
        fun baselineCount(nonce: String, fingerprint: String): Int? =
            if (activeArm?.nonce == nonce) baselineCounts?.get(fingerprint) ?: 0 else null

        @Synchronized
        fun remember(evidence: CreateEvidence) {
            if (activeArm?.nonce != evidence.nonce || baselineCounts == null) return
            recentCreates.addLast(evidence)
            while (recentCreates.size > MAX_RECENT_CREATES) recentCreates.removeFirst()
        }

        @Synchronized
        fun recentSnapshot(nonce: String): List<CreateEvidence> =
            if (activeArm?.nonce == nonce) recentCreates.toList() else emptyList()

        @Synchronized
        fun forget(evidence: CreateEvidence) {
            recentCreates.remove(evidence)
        }

        @Synchronized
        internal fun retainedCreateCount(): Int = recentCreates.size

        @Synchronized
        internal fun hasBaseline(): Boolean = baselineCounts != null
    }

    private val pendingEvidence = ThreadLocal<PendingEvidence?>()
    private val continuationFingerprints =
        Collections.synchronizedMap(WeakHashMap<Any, PendingEvidence>())
    private val evidenceWindow = EvidenceWindow()
    @Volatile private var armChangeCallbackInstalled = false
    private val expiryScheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "PenumbraFoodEvidenceExpiry").apply { isDaemon = true }
    }
    private val expiryLock = Any()
    private var scheduledArm: ActiveArm? = null
    private var scheduledExpiry: ScheduledFuture<*>? = null

    internal fun installAudited(
        classLoader: ClassLoader,
        packageName: String,
        processName: String,
        sourceApk: FoodTaoDeadlineHooks.AuditedFoodApk,
    ) {
        if (!FoodTaoDeadlineHooks.exactRuntime(packageName, processName)) return
        if (!FoodTaoDeadlineHooks.auditedApkMetadata(
                sourceApk.canonicalPath,
                sourceApk.size,
                sourceApk.sha256,
            )
        ) {
            Log.e(TAG, "  Refusing Food evidence hook: loaded APK is not audited stock")
            return
        }
        val wrapper = classLoader.loadClass(WRAPPER_CLASS)
        val trackContinuation = classLoader.loadClass(TRACK_CONTINUATION_CLASS)
        val lookupContinuation = classLoader.loadClass(LOOKUP_CONTINUATION_CLASS)
        val readContinuation = classLoader.loadClass(READ_CONTINUATION_CLASS)
        installArmChangeCallback()

        val track = wrapper.declaredMethods.singleOrNull { it.name == "trackFoodItemConsumption" }
            ?.takeIf { exactTrackShape(methodShape(it)) }
            ?: throw LinkageError("stock Food track method shape changed")
        val trackConstructor = trackContinuation.declaredConstructors.singleOrNull()
            ?.takeIf { constructor ->
                constructor.parameterTypes.map(Class<*>::getName) ==
                    listOf(WRAPPER_CLASS, CONTINUATION_CLASS)
            } ?: throw LinkageError("stock Food track continuation shape changed")
        val trackCompletion = trackContinuation.declaredMethods
            .singleOrNull { it.name == "invokeSuspend" }
            ?.takeIf { exactCompletionShape(methodShape(it)) }
            ?: throw LinkageError("stock Food track completion shape changed")
        val lookupCompletion = lookupContinuation.declaredMethods
            .singleOrNull { it.name == "invokeSuspend" }
            ?.takeIf { exactCompletionShape(methodShape(it)) }
            ?: throw LinkageError("stock Food lookup completion shape changed")
        val readCompletion = readContinuation.declaredMethods
            .singleOrNull { it.name == "invokeSuspend" }
            ?.takeIf { exactCompletionShape(methodShape(it)) }
            ?: throw LinkageError("stock Food read completion shape changed")

        XposedBridge.hookMethod(track, object : XC_MethodHook() {
            override fun beforeHookedMethod(param: MethodHookParam) {
                observeContained("track input") {
                    pendingEvidence.remove()
                    val nonce = activeArm()?.nonce ?: return@observeContained
                    val foodItem = param.args.getOrNull(0) ?: return@observeContained
                    val quantity = param.args.getOrNull(1) as? Float ?: return@observeContained
                    val requestUuid = requestUuid(foodItem) ?: return@observeContained
                    val itemToken = memoryToken(nonce, requestUuid) ?: return@observeContained
                    if (!evidenceWindow.consumeLookup(nonce, itemToken)) {
                        return@observeContained
                    }
                    fingerprintFoodItem(foodItem, quantity)?.let { fingerprint ->
                        val baselineCount = evidenceWindow.baselineCount(nonce, fingerprint)
                            ?: return@let
                        pendingEvidence.set(
                            PendingEvidence(fingerprint, itemToken, nonce, baselineCount),
                        )
                    }
                }
            }

            override fun afterHookedMethod(param: MethodHookParam) {
                observeContained("track input cleanup") { pendingEvidence.remove() }
            }
        })
        XposedBridge.hookMethod(lookupCompletion, object : XC_MethodHook() {
            override fun afterHookedMethod(param: MethodHookParam) {
                observeContained("lookup completion") {
                    val nonce = activeArm()?.nonce ?: return@observeContained
                    val itemToken = lookupItemToken(nonce, param.result)
                        ?: return@observeContained
                    evidenceWindow.recordLookup(nonce, itemToken)
                    Log.i(TAG, "FoodRoundTrip lookup item_token=$itemToken")
                }
            }
        })
        XposedBridge.hookMethod(trackConstructor, object : XC_MethodHook() {
            override fun afterHookedMethod(param: MethodHookParam) {
                observeContained("track continuation") {
                    val pending = pendingEvidence.get() ?: return@observeContained
                    continuationFingerprints[param.thisObject] = pending
                }
            }
        })
        XposedBridge.hookMethod(trackCompletion, object : XC_MethodHook() {
            override fun afterHookedMethod(param: MethodHookParam) {
                observeContained("track completion") {
                    val pending = continuationFingerprints.remove(param.thisObject)
                        ?: return@observeContained
                    if (activeArm()?.nonce != pending.nonce) return@observeContained
                    successfulCreateEvidence(param.result, pending)?.let { evidence ->
                        evidenceWindow.remember(evidence)
                        Log.i(
                            TAG,
                            "FoodRoundTrip create status=success " +
                                "item_token=${evidence.itemToken} " +
                                "memory_token=${evidence.memoryToken}",
                        )
                    }
                }
            }
        })
        XposedBridge.hookMethod(readCompletion, object : XC_MethodHook() {
            override fun afterHookedMethod(param: MethodHookParam) {
                observeContained("read completion") {
                    val nonce = activeArm()?.nonce ?: return@observeContained
                    val result = param.result ?: return@observeContained
                    val fingerprints = summaryFingerprintCounts(result) ?: return@observeContained
                    val recent = evidenceWindow.recentSnapshot(nonce)
                    if (recent.isEmpty()) {
                        if (evidenceWindow.recordBaseline(nonce, fingerprints)) {
                            Log.i(TAG, "FoodRoundTrip baseline status=success")
                        }
                        return@observeContained
                    }
                    for (evidence in recent) {
                        val matched = exactReadbackCount(
                            evidence.baselineCount,
                            fingerprints[evidence.fingerprint] ?: 0,
                        )
                        Log.i(
                            TAG,
                            "FoodRoundTrip read item_token=${evidence.itemToken} " +
                                "memory_token=${evidence.memoryToken} " +
                                "readback_match=$matched",
                        )
                        if (matched) evidenceWindow.forget(evidence)
                    }
                }
            }
        })
        Log.w(TAG, "  Food round-trip evidence hooks installed")
    }

    internal fun exactTrackShape(shape: MethodShape): Boolean =
        shape.name == "trackFoodItemConsumption" &&
            shape.returnType == Any::class.java.name &&
            shape.parameterTypes == listOf(FOOD_ITEM_CLASS, "float", CONTINUATION_CLASS) &&
            shape.isPublic &&
            !shape.isStatic

    internal fun exactCompletionShape(shape: MethodShape): Boolean =
        shape.name == "invokeSuspend" &&
            shape.returnType == Any::class.java.name &&
            shape.parameterTypes == listOf(Any::class.java.name) &&
            shape.isPublic &&
            !shape.isStatic

    internal fun memoryToken(nonce: String, uuid: String): String? {
        if (!NONCE_PATTERN.matches(nonce) || !UUID_PATTERN.matches(uuid)) return null
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(nonce.toByteArray(Charsets.US_ASCII), "HmacSHA256"))
        return mac.doFinal(uuid.toByteArray(Charsets.US_ASCII)).toHex()
    }

    internal fun lookupItemToken(nonce: String, result: Any?): String? {
        if (result?.javaClass?.name != GET_FOOD_ITEM_RESPONSE_CLASS) return null
        val hasBestFoodItem = result.javaClass
            .getMethod("hasBestFoodItem")
            .invoke(result) as? Boolean ?: return null
        if (!hasBestFoodItem) return null
        val bestFoodItem = result.javaClass
            .getMethod("getBestFoodItem")
            .invoke(result) ?: return null
        val uuid = requestUuid(bestFoodItem) ?: return null
        return memoryToken(nonce, uuid)
    }

    internal fun exactReadbackCount(baselineCount: Int, observedCount: Int): Boolean =
        baselineCount >= 0 && observedCount == baselineCount + 1

    internal fun evidenceArmed(): Boolean = try {
        activeArm() != null
    } catch (_: Throwable) {
        false
    }

    private fun successfulCreateEvidence(
        result: Any?,
        pending: PendingEvidence,
    ): CreateEvidence? {
        if (result?.javaClass?.name != CREATE_RESPONSE_CLASS) return null
        val status = result.javaClass.getMethod("getStatusValue").invoke(result) as? Int ?: return null
        if (status != 1) return null
        val hasMemory = result.javaClass.getMethod("hasMemory").invoke(result) as? Boolean ?: false
        if (!hasMemory) return null
        val memory = result.javaClass.getMethod("getMemory").invoke(result) ?: return null
        val uuid = memory.javaClass.getMethod("getUuid").invoke(memory) as? String ?: return null
        if (!UUID_PATTERN.matches(uuid)) return null
        val token = memoryToken(pending.nonce, uuid) ?: return null
        return CreateEvidence(
            pending.fingerprint,
            pending.itemToken,
            token,
            pending.nonce,
            pending.baselineCount,
        )
    }

    private fun summaryFingerprintCounts(result: Any): Map<String, Int>? {
        if (result.javaClass.name != FOOD_LOG_SUMMARY_CLASS) return null
        val logs = result.javaClass.getMethod("getFoodLogsList").invoke(result) as? List<*> ?: return null
        if (logs.size > 10_000) return null
        return logs.mapNotNull { log ->
            log ?: return@mapNotNull null
            val foodItem = log.javaClass.getMethod("getFoodItem").invoke(log) ?: return@mapNotNull null
            val quantity = log.javaClass.getMethod("getServingsConsumed").invoke(log) as? Float
                ?: return@mapNotNull null
            fingerprintFoodItem(foodItem, quantity)
        }.groupingBy { it }.eachCount()
    }

    private fun fingerprintFoodItem(foodItem: Any, quantity: Float): String? {
        if (foodItem.javaClass.name != FOOD_ITEM_CLASS || !quantity.isFinite()) return null
        val bytes = foodItem.javaClass.getMethod("toByteArray").invoke(foodItem) as? ByteArray
            ?: return null
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(ByteBuffer.allocate(Int.SIZE_BYTES).putInt(bytes.size).array())
        digest.update(bytes)
        digest.update(ByteBuffer.allocate(Int.SIZE_BYTES).putInt(quantity.toRawBits()).array())
        return digest.digest().toHex()
    }

    private fun requestUuid(foodItem: Any?): String? {
        if (foodItem?.javaClass?.name != FOOD_ITEM_CLASS) return null
        val uuid = foodItem.javaClass.getMethod("getRequestUuid").invoke(foodItem) as? String
            ?: return null
        return uuid.takeIf(UUID_PATTERN::matches)
    }

    private inline fun observeContained(label: String, observation: () -> Unit) {
        try {
            observation()
        } catch (error: Throwable) {
            Log.e(TAG, "  Food round-trip $label observation failed; stock result preserved", error)
        }
    }

    private fun activeArm(): ActiveArm? {
        val systemProperties = Class.forName("android.os.SystemProperties")
        val value = systemProperties
            .getMethod("get", String::class.java)
            .invoke(null, ARM_PROPERTY) as? String
        val arm = parseActiveArm(value, System.currentTimeMillis() / 1_000L)
        val changed = evidenceWindow.synchronize(arm)
        scheduleArmExpiry(arm)
        if (changed) {
            pendingEvidence.remove()
            continuationFingerprints.clear()
        }
        return arm
    }

    private fun scheduleArmExpiry(arm: ActiveArm?) {
        synchronized(expiryLock) {
            if (scheduledArm == arm && scheduledExpiry?.isDone == false) return
            scheduledExpiry?.cancel(false)
            scheduledExpiry = null
            scheduledArm = arm
            if (arm == null) return
            val nowSeconds = System.currentTimeMillis() / 1_000L
            val delaySeconds = (arm.expiresAtSeconds - nowSeconds).coerceAtLeast(0L)
            scheduledExpiry = expiryScheduler.schedule(
                {
                    val isCurrent = synchronized(expiryLock) {
                        if (scheduledArm != arm) {
                            false
                        } else {
                            scheduledArm = null
                            scheduledExpiry = null
                            true
                        }
                    }
                    if (isCurrent && evidenceWindow.expire(arm)) {
                        continuationFingerprints.clear()
                    }
                },
                delaySeconds,
                TimeUnit.SECONDS,
            )
        }
    }

    @Synchronized
    private fun installArmChangeCallback() {
        if (armChangeCallbackInstalled) return
        val systemProperties = Class.forName("android.os.SystemProperties")
        systemProperties
            .getDeclaredMethod("addChangeCallback", Runnable::class.java)
            .invoke(null, Runnable {
                observeContained("arm state change") { activeArm() }
            })
        armChangeCallbackInstalled = true
    }

    internal fun parseActiveArm(value: String?, nowSeconds: Long): ActiveArm? {
        if (value == null) return null
        val match = ARM_PATTERN.matchEntire(value) ?: return null
        val expiresAt = match.groupValues[2].toLongOrNull() ?: return null
        if (
            nowSeconds < 0L ||
            expiresAt <= nowSeconds ||
            expiresAt - nowSeconds > MAX_ARM_WINDOW_SECONDS
        ) return null
        return ActiveArm(match.groupValues[1], expiresAt)
    }

    private fun methodShape(method: Method): MethodShape = MethodShape(
        name = method.name,
        returnType = method.returnType.name,
        parameterTypes = method.parameterTypes.map(Class<*>::getName),
        isPublic = Modifier.isPublic(method.modifiers),
        isStatic = Modifier.isStatic(method.modifiers),
    )

    private fun ByteArray.toHex(): String = joinToString(separator = "") { byte ->
        "%02x".format(byte.toInt() and 0xff)
    }
}
