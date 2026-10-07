package com.penumbraos.hook

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KryptoWorkManagerHooksTest {
    @Test
    fun `repair is limited to remote Luma when WorkManager is absent`() {
        assertFalse(
            KryptoWorkManagerHooks.shouldInitializeWorkManager(
                remoteEnabled = false,
                workManagerInitialized = false,
            ),
        )
        assertFalse(
            KryptoWorkManagerHooks.shouldInitializeWorkManager(
                remoteEnabled = true,
                workManagerInitialized = true,
            ),
        )
        assertTrue(
            KryptoWorkManagerHooks.shouldInitializeWorkManager(
                remoteEnabled = true,
                workManagerInitialized = false,
            ),
        )
    }

    @Test
    fun `repair runs before stock SystemJobService onCreate without replacing it`() {
        val source = sourceFile(
            "src/main/kotlin/com/penumbraos/hook/KryptoWorkManagerHooks.kt",
        ).readText()

        assertTrue(source.contains("androidx.work.impl.background.systemjob.SystemJobService"))
        assertTrue(source.contains("hookMethodBefore("))
        assertTrue(source.contains("\"onCreate\""))
        assertFalse(source.contains("param.result ="))
        assertTrue(source.contains("catch (error: Throwable)"))
    }

    @Test
    fun `reviewed stock krypto initializes workers in a different process from its job service`() {
        StockReference.requireReviewedApk(
            "krypto.apk",
            "fedb2ddc56826e2a83bc130260b515e1f38c80e21794911a6190f16475bd1fed",
        )
        val manifest = StockReference.decompiled(
            "krypto/resources/AndroidManifest.xml",
            "a949ba984b6c0633eb4ed7a31c782dc4ca02f079e3800b0c33917ea314559a45",
        ).readText()
        val kryptoService = StockReference.decompiled(
            "krypto/sources/humaneinternal/system/krypto/KryptoService.java",
            "b41be1918387f437d461e644fafefc8cd7dee3303c022bd19f5ab9e587dd73ba",
        ).readText()
        val jobService = StockReference.decompiled(
            "krypto/sources/androidx/work/impl/background/systemjob/SystemJobService.java",
            "3d396a413afda9e128440cc6bbe41678008e7284288adbe61ff8f0424a71bc49",
        ).readText()

        val kryptoDeclaration = manifest.substringAfter(
            "android:name=\"humaneinternal.system.krypto.KryptoService\"",
        ).substringBefore("</service>")
        val jobDeclaration = manifest.substringAfter(
            "android:name=\"androidx.work.impl.background.systemjob.SystemJobService\"",
        ).substringBefore("</service>")

        assertTrue(kryptoDeclaration.contains("android:process=\":krypto\""))
        assertFalse(jobDeclaration.contains("android:process="))
        assertTrue(kryptoService.contains("WorkManager.initialize(applicationContext"))
        assertTrue(jobService.contains("if (this.mWorkManagerImpl == null)"))
        assertTrue(jobService.contains("jobFinished(params, true);"))
        assertTrue(jobService.contains("return false;"))
    }

    private fun sourceFile(relativePath: String): File {
        val candidates = listOf(File(relativePath), File("hook/module", relativePath))
        return candidates.firstOrNull { it.isFile }
            ?: throw AssertionError("Missing Krypto WorkManager hook source: $relativePath")
    }
}
