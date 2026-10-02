package com.penumbraos.hook

import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FoodTaoDeadlineHooksTest {
    private val exactMethod = FoodTaoDeadlineHooks.MethodShape(
        name = FoodTaoDeadlineHooks.TAO_METHOD,
        returnType = CompletableFuture::class.java.name,
        parameterTypes = listOf(FoodTaoDeadlineHooks.REQUEST_CLASS),
        isPublic = true,
        isStatic = false,
    )
    private val exactStack = listOf(
        StackTraceElement("java.lang.Thread", "getStackTrace", null, -1),
        StackTraceElement(
            "com.penumbraos.hook.FoodTaoDeadlineHooks\$installVerified\$2",
            "beforeHookedMethod",
            null,
            -1,
        ),
        StackTraceElement(
            FoodTaoDeadlineHooks.ALIUHOOK_CALLBACK_CLASS,
            "callback",
            "XposedBridge.java",
            119,
        ),
        StackTraceElement(
            FoodTaoDeadlineHooks.LSPLANT_TARGET_CLASS,
            "orTimeout",
            "LSP",
            -1,
        ),
        StackTraceElement(
            FoodTaoDeadlineHooks.TAO_CLASS,
            FoodTaoDeadlineHooks.TAO_METHOD,
            null,
            -1,
        ),
    )

    @Test
    fun `exact stock Food Tao timeout is extended to sixty seconds`() {
        assertEquals(
            FoodTaoDeadlineHooks.EXTENDED_TIMEOUT_SECONDS,
            FoodTaoDeadlineHooks.replacementTimeoutSeconds(
                FoodTaoDeadlineHooks.TARGET_PACKAGE,
                FoodTaoDeadlineHooks.TARGET_PROCESS,
                true,
                exactStack,
                FoodTaoDeadlineHooks.EXPECTED_STOCK_TIMEOUT_SECONDS,
                TimeUnit.SECONDS,
            ),
        )
        assertEquals(
            FoodTaoDeadlineHooks.EXTENDED_TIMEOUT_SECONDS,
            FoodTaoDeadlineHooks.replacementTimeoutSeconds(
                FoodTaoDeadlineHooks.TARGET_PACKAGE,
                FoodTaoDeadlineHooks.TARGET_PROCESS,
                true,
                exactStack.toMutableList().apply {
                    add(
                        4,
                        StackTraceElement(
                            "java.lang.reflect.Method",
                            "invoke",
                            "Method.java",
                            -1,
                        ),
                    )
                },
                FoodTaoDeadlineHooks.EXPECTED_STOCK_TIMEOUT_SECONDS,
                TimeUnit.SECONDS,
            ),
        )
    }

    @Test
    fun `wrong package process callback caller value or unit always keeps stock behavior`() {
        fun rewrite(
            packageName: String? = FoodTaoDeadlineHooks.TARGET_PACKAGE,
            processName: String? = FoodTaoDeadlineHooks.TARGET_PROCESS,
            insideAuditedTaoCall: Boolean = true,
            stack: List<StackTraceElement> = exactStack,
            timeout: Long = FoodTaoDeadlineHooks.EXPECTED_STOCK_TIMEOUT_SECONDS,
            unit: TimeUnit? = TimeUnit.SECONDS,
        ) = FoodTaoDeadlineHooks.replacementTimeoutSeconds(
            packageName,
            processName,
            insideAuditedTaoCall,
            stack,
            timeout,
            unit,
        )

        assertNull(rewrite(packageName = "hu.ma.ne.ironman"))
        assertNull(rewrite(processName = "humane.experience.food:worker"))
        assertNull(rewrite(insideAuditedTaoCall = false))
        assertNull(
            rewrite(
                stack = listOf(
                    exactStack[0],
                    exactStack[1],
                    exactStack[2],
                    exactStack[3],
                    StackTraceElement("nested.Helper", "applyTimeout", null, -1),
                    exactStack[4],
                ),
            ),
        )
        assertNull(rewrite(stack = exactStack + exactStack))
        assertNull(
            rewrite(
                stack = exactStack.toMutableList().apply {
                    this[2] = StackTraceElement(
                        "de.robv.android.xposed.XposedBridge",
                        "callback",
                        null,
                        -1,
                    )
                },
            ),
        )
        assertNull(
            rewrite(
                stack = listOf(
                    StackTraceElement(
                        CompletableFuture::class.java.name,
                        "orTimeout",
                        null,
                        -1,
                    ),
                    exactStack[4],
                ),
            ),
        )
        assertNull(rewrite(timeout = 9L))
        assertNull(rewrite(timeout = FoodTaoDeadlineHooks.EXTENDED_TIMEOUT_SECONDS))
        assertNull(rewrite(unit = TimeUnit.MILLISECONDS))
        assertNull(rewrite(unit = null))
    }

    @Test
    fun `missing ambiguous or changed Tao firmware shape refuses closed`() {
        fun inspect(vararg candidates: Pair<String, List<FoodTaoDeadlineHooks.MethodShape>>) =
            FoodTaoDeadlineHooks.inspectTaoCandidates(candidates.toList())

        assertEquals(FoodTaoDeadlineHooks.TaoShapeResult.CLASS_MISSING, inspect())
        assertEquals(
            FoodTaoDeadlineHooks.TaoShapeResult.CLASS_AMBIGUOUS,
            inspect(
                FoodTaoDeadlineHooks.TAO_CLASS to listOf(exactMethod),
                FoodTaoDeadlineHooks.TAO_CLASS to listOf(exactMethod),
            ),
        )
        assertEquals(
            FoodTaoDeadlineHooks.TaoShapeResult.METHOD_MISSING,
            inspect(FoodTaoDeadlineHooks.TAO_CLASS to emptyList()),
        )
        assertEquals(
            FoodTaoDeadlineHooks.TaoShapeResult.METHOD_AMBIGUOUS,
            inspect(FoodTaoDeadlineHooks.TAO_CLASS to listOf(exactMethod, exactMethod)),
        )
        for (changed in listOf(
            exactMethod.copy(returnType = "java.lang.Object"),
            exactMethod.copy(parameterTypes = emptyList()),
            exactMethod.copy(isPublic = false),
            exactMethod.copy(isStatic = true),
        )) {
            assertEquals(
                FoodTaoDeadlineHooks.TaoShapeResult.METHOD_SHAPE_CHANGED,
                inspect(FoodTaoDeadlineHooks.TAO_CLASS to listOf(changed)),
            )
        }
    }

    @Test
    fun `hook remains bound to audited Food artifact and exact orTimeout call site`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/FoodTaoDeadlineHooks.kt",
        ).readText()
        val build = sourceFile("build.gradle.kts").readText()

        assertEquals(
            "acc2e0d726d35cc123869ad0fff36d38124ea04da0f24df7125deb8352ddd06d",
            FoodTaoDeadlineHooks.AUDITED_FOOD_SHA256,
        )
        assertTrue(source.contains("CompletableFuture::class.java.declaredMethods"))
        assertTrue(source.contains("it.name == \"orTimeout\""))
        assertTrue(source.contains("XposedBridge.hookMethod(taoMethod"))
        assertTrue(source.contains("insideAuditedTaoCall = auditedTaoDepth.get() == 1"))
        assertTrue(source.contains("Thread.currentThread().stackTrace"))
        assertTrue(source.contains("exactAliuhookTimeoutSite(stack)"))
        assertTrue(source.contains("LSPLANT_TARGET_CLASS = \"LSPHooker_\""))
        assertEquals(
            "de.robv.android.xposed.XposedBridge\$HookInfo",
            FoodTaoDeadlineHooks.ALIUHOOK_CALLBACK_CLASS,
        )
        assertTrue(build.contains("implementation(\"com.aliucord:Aliuhook:1.1.4\")"))
        assertTrue(source.contains("sourceApk: AuditedFoodApk"))
        assertTrue(source.contains("canonical.inputStream().buffered().use"))
        assertTrue(source.contains("FoodTao deadline_rewrite=10_to_60"))
        assertTrue(source.contains("FoodRoundTripEvidenceHooks.evidenceArmed()"))
        assertTrue(source.contains("Food Tao deadline callback failed; keeping stock behavior"))
        assertTrue(FoodTaoDeadlineHooks.EXTENDED_TIMEOUT_SECONDS <= 60L)
    }

    @Test
    fun `runtime Food artifact metadata must all match the audited APK`() {
        fun matches(
            path: String? = FoodTaoDeadlineHooks.AUDITED_FOOD_PATH,
            size: Long = FoodTaoDeadlineHooks.AUDITED_FOOD_SIZE,
            sha256: String? = FoodTaoDeadlineHooks.AUDITED_FOOD_SHA256,
        ) = FoodTaoDeadlineHooks.auditedApkMetadata(path, size, sha256)

        assertTrue(matches())
        assertFalse(matches(path = "/data/app/humane.experience.food/base.apk"))
        assertFalse(matches(size = FoodTaoDeadlineHooks.AUDITED_FOOD_SIZE - 1))
        assertFalse(matches(sha256 = "0".repeat(64)))
        assertFalse(matches(path = null))
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/module", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing source contract file: $relativePath")
    }
}
