package com.penumbraos.hook

import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import com.penumbraos.stockaibus.contract.StockAiBusContract
import com.penumbraos.stockaibus.contract.TierASymbols
import java.io.File
import java.lang.reflect.Method
import java.lang.reflect.Modifier
import java.security.MessageDigest
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * Extends only the stock Food Tao aggregate deadline.
 *
 * The audited Food build owns a multi-step Tao turn in
 * `TaoAgent.understandAsync`: model, tool, model, then the terminal response.
 * Its literal ten-second `CompletableFuture.orTimeout` can expire after the
 * provider lookup and CreateMemory have both succeeded. Java exposes no handle
 * for replacing that scheduled timeout after the call returns, so the narrow
 * interception seam is `orTimeout` inside the exact Food process. Every other
 * caller and argument shape keeps stock behavior.
 */
object FoodTaoDeadlineHooks {
    private const val TAG = "LumaCompatibility"

    internal const val TARGET_PACKAGE = TierASymbols.Packages.FOOD
    internal const val TARGET_PROCESS = TARGET_PACKAGE
    internal const val TAO_CLASS = "humaneinternal.system.tao.TaoAgent"
    internal const val TAO_METHOD = "understandAsync"
    internal const val REQUEST_CLASS = "humane.aibus.SynapseUserRequestContent"
    internal const val AUDITED_FOOD_SHA256 = StockAiBusContract.FOOD_SHA256
    internal const val AUDITED_FOOD_PATH = "/system/app/humane_food/humane_food.apk"
    internal const val AUDITED_FOOD_SIZE = 70_155_293L
    internal const val EXPECTED_STOCK_TIMEOUT_SECONDS = 10L
    internal const val EXTENDED_TIMEOUT_SECONDS = 60L
    internal const val LSPLANT_TARGET_CLASS = "LSPHooker_"
    internal const val ALIUHOOK_CALLBACK_CLASS =
        "de.robv.android.xposed.XposedBridge\$HookInfo"
    private val auditedTaoDepth = ThreadLocal<Int?>()

    internal data class AuditedFoodApk(
        val canonicalPath: String,
        val size: Long,
        val sha256: String,
    )

    internal data class MethodShape(
        val name: String,
        val returnType: String,
        val parameterTypes: List<String>,
        val isPublic: Boolean,
        val isStatic: Boolean,
    )

    internal enum class TaoShapeResult {
        EXACT,
        CLASS_MISSING,
        CLASS_AMBIGUOUS,
        METHOD_MISSING,
        METHOD_AMBIGUOUS,
        METHOD_SHAPE_CHANGED,
    }

    internal fun installAudited(
        classLoader: ClassLoader,
        packageName: String,
        processName: String,
        sourceApk: AuditedFoodApk,
    ) {
        try {
            installVerified(classLoader, packageName, processName, sourceApk)
        } catch (error: Throwable) {
            Log.e(TAG, "  Food Tao deadline inspection failed; keeping stock behavior", error)
        }
    }

    private fun installVerified(
        classLoader: ClassLoader,
        packageName: String,
        processName: String,
        sourceApk: AuditedFoodApk,
    ) {
        if (!exactRuntime(packageName, processName)) {
            Log.e(TAG, "  Refusing Food Tao deadline hook outside its exact runtime")
            return
        }
        if (!auditedApkMetadata(sourceApk.canonicalPath, sourceApk.size, sourceApk.sha256)) {
            Log.e(TAG, "  Refusing Food Tao deadline hook: loaded APK is not the audited stock artifact")
            return
        }

        val taoClass = try {
            classLoader.loadClass(TAO_CLASS)
        } catch (_: ClassNotFoundException) {
            Log.e(TAG, "  Refusing Food Tao deadline hook: stock Tao class is missing")
            return
        }
        val taoMethods = taoClass.declaredMethods.filter { it.name == TAO_METHOD }
        val taoShape = inspectTaoCandidates(
            listOf(
                taoClass.name to taoMethods.map(::methodShape),
            ),
        )
        if (taoShape != TaoShapeResult.EXACT) {
            Log.e(TAG, "  Refusing Food Tao deadline hook: stock shape is $taoShape")
            return
        }

        val timeoutMethods = CompletableFuture::class.java.declaredMethods.filter {
            it.name == "orTimeout"
        }
        val timeoutMethod = timeoutMethods.singleOrNull()
        if (timeoutMethod == null || !exactOrTimeoutShape(methodShape(timeoutMethod))) {
            Log.e(TAG, "  Refusing Food Tao deadline hook: orTimeout shape changed")
            return
        }

        val taoMethod = taoMethods.single()
        try {
            XposedBridge.hookMethod(taoMethod, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    try {
                        auditedTaoDepth.set((auditedTaoDepth.get() ?: 0) + 1)
                    } catch (error: Throwable) {
                        auditedTaoDepth.remove()
                        Log.e(TAG, "  Food Tao call-site guard failed; keeping stock behavior", error)
                    }
                }

                override fun afterHookedMethod(param: MethodHookParam) {
                    try {
                        val depth = auditedTaoDepth.get() ?: 0
                        if (depth <= 1) auditedTaoDepth.remove()
                        else auditedTaoDepth.set(depth - 1)
                    } catch (error: Throwable) {
                        auditedTaoDepth.remove()
                        Log.e(TAG, "  Food Tao call-site cleanup failed", error)
                    }
                }
            })
            XposedBridge.hookMethod(timeoutMethod, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    try {
                        val stockTimeout = param.args.getOrNull(0) as? Long ?: return
                        val unit = param.args.getOrNull(1) as? TimeUnit ?: return
                        val replacement = replacementTimeoutSeconds(
                            packageName = packageName,
                            processName = processName,
                            insideAuditedTaoCall = auditedTaoDepth.get() == 1,
                            stack = Thread.currentThread().stackTrace.toList(),
                            timeout = stockTimeout,
                            unit = unit,
                        ) ?: return
                        param.args[0] = replacement
                        if (FoodRoundTripEvidenceHooks.evidenceArmed()) {
                            Log.i(TAG, "FoodTao deadline_rewrite=10_to_60")
                        }
                    } catch (error: Throwable) {
                        Log.e(TAG, "  Food Tao deadline callback failed; keeping stock behavior", error)
                    }
                }
            })
            Log.w(
                TAG,
                "  Food Tao aggregate deadline extended to ${EXTENDED_TIMEOUT_SECONDS}s",
            )
        } catch (error: Throwable) {
            Log.e(TAG, "  Food Tao deadline hook install failed; keeping stock behavior", error)
        }
    }

    internal fun exactRuntime(packageName: String?, processName: String?): Boolean =
        packageName == TARGET_PACKAGE && processName == TARGET_PROCESS

    internal fun auditedApkMetadata(path: String?, size: Long, sha256: String?): Boolean =
        path == AUDITED_FOOD_PATH &&
            size == AUDITED_FOOD_SIZE &&
            sha256 == AUDITED_FOOD_SHA256

    internal fun verifyAuditedFoodApk(sourceApk: File?): AuditedFoodApk? {
        val file = sourceApk ?: return null
        if (!file.isFile) return null
        val canonical = file.canonicalFile
        val digest = MessageDigest.getInstance("SHA-256")
        canonical.inputStream().buffered().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (count > 0) digest.update(buffer, 0, count)
            }
        }
        val verified = AuditedFoodApk(
            canonicalPath = canonical.path,
            size = canonical.length(),
            sha256 = digest.digest().toHex(),
        )
        return verified.takeIf {
            auditedApkMetadata(it.canonicalPath, it.size, it.sha256)
        }
    }

    internal fun isAuditedFoodApk(sourceApk: File?): Boolean =
        verifyAuditedFoodApk(sourceApk) != null

    internal fun inspectTaoCandidates(
        candidates: List<Pair<String, List<MethodShape>>>,
    ): TaoShapeResult {
        val matchingClasses = candidates.filter { it.first == TAO_CLASS }
        if (matchingClasses.isEmpty()) return TaoShapeResult.CLASS_MISSING
        if (matchingClasses.size != 1) return TaoShapeResult.CLASS_AMBIGUOUS
        val methods = matchingClasses.single().second.filter { it.name == TAO_METHOD }
        if (methods.isEmpty()) return TaoShapeResult.METHOD_MISSING
        if (methods.size != 1) return TaoShapeResult.METHOD_AMBIGUOUS
        return if (exactTaoMethodShape(methods.single())) {
            TaoShapeResult.EXACT
        } else {
            TaoShapeResult.METHOD_SHAPE_CHANGED
        }
    }

    internal fun replacementTimeoutSeconds(
        packageName: String?,
        processName: String?,
        insideAuditedTaoCall: Boolean,
        stack: List<StackTraceElement>,
        timeout: Long,
        unit: TimeUnit?,
    ): Long? {
        if (!exactRuntime(packageName, processName)) return null
        if (!insideAuditedTaoCall) return null
        if (timeout != EXPECTED_STOCK_TIMEOUT_SECONDS || unit != TimeUnit.SECONDS) return null
        if (!exactAliuhookTimeoutSite(stack)) return null
        return EXTENDED_TIMEOUT_SECONDS
    }

    internal fun exactAliuhookTimeoutSite(stack: List<StackTraceElement>): Boolean {
        val targetIndexes = stack.indices.filter { index ->
            val frame = stack[index]
            frame.className == LSPLANT_TARGET_CLASS && frame.methodName == "orTimeout"
        }
        if (targetIndexes.size != 1) return false
        val targetIndex = targetIndexes.single()
        val callback = stack.getOrNull(targetIndex - 1) ?: return false
        if (
            callback.className != ALIUHOOK_CALLBACK_CLASS ||
            callback.methodName != "callback"
        ) return false
        val targetCaller = stack
            .drop(targetIndex + 1)
            .firstOrNull { !exactAliuhookBridgeFrame(it) }
            ?: return false
        return targetCaller.className == TAO_CLASS && targetCaller.methodName == TAO_METHOD
    }

    private fun exactAliuhookBridgeFrame(frame: StackTraceElement): Boolean =
        frame.className == "java.lang.reflect.Method" && frame.methodName == "invoke"

    private fun exactTaoMethodShape(shape: MethodShape): Boolean =
        shape.name == TAO_METHOD &&
            shape.returnType == CompletableFuture::class.java.name &&
            shape.parameterTypes == listOf(REQUEST_CLASS) &&
            shape.isPublic &&
            !shape.isStatic

    private fun exactOrTimeoutShape(shape: MethodShape): Boolean =
        shape.name == "orTimeout" &&
            shape.returnType == CompletableFuture::class.java.name &&
            shape.parameterTypes == listOf("long", TimeUnit::class.java.name) &&
            shape.isPublic &&
            !shape.isStatic

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
