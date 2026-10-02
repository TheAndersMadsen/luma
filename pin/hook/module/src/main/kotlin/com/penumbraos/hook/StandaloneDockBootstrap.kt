package com.penumbraos.hook

import android.app.Application
import android.content.Context
import android.util.Log
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

internal data class StandaloneDockArtifacts(
    val apk: File,
    val payload: File,
)

internal fun standaloneDockLaunchCommand(
    apkPath: String,
    payloadPath: String,
): List<String> = listOf(
    "/system/bin/app_process64",
    "/system/bin",
    "--nice-name=luma-standalone-dock",
    "com.penumbraos.hook.StandaloneDockMain",
    apkPath,
    payloadPath,
)

internal object StandaloneDockBootstrap {
    const val SHELL_PACKAGE = "com.android.shell"
    private val started = AtomicBoolean(false)

    fun install(classLoader: ClassLoader) {
        if (!started.compareAndSet(false, true)) return
        try {
            val artifacts = resolveArtifacts(classLoader)
            if (artifacts == null) {
                Log.e(HookComponentFactory.TAG, "Standalone dock payload unavailable; skipping")
                return
            }
            Thread(
                {
                    try {
                        val context = awaitApplicationContext()
                        if (context == null || !StandaloneDockCpuPromotion.promote(context)) {
                            Log.e(
                                HookComponentFactory.TAG,
                                "Standalone dock CPU 7 handoff failed; refusing runner launch",
                            )
                            return@Thread
                        }
                        val process = ProcessBuilder(
                            standaloneDockLaunchCommand(
                                artifacts.apk.absolutePath,
                                artifacts.payload.absolutePath,
                            ),
                        )
                        process.environment()["CLASSPATH"] = artifacts.apk.absolutePath
                        process.redirectErrorStream(true)
                        process.redirectOutput(File("/dev/null"))
                        process.start()
                        Log.w(HookComponentFactory.TAG, "Standalone dock runner launched")
                    } catch (error: Throwable) {
                        Log.e(HookComponentFactory.TAG, "Standalone dock runner launch failed", error)
                    }
                },
                "LumaStandaloneDockLaunch",
            ).apply { isDaemon = true }.start()
        } catch (error: Throwable) {
            Log.e(HookComponentFactory.TAG, "Standalone dock bootstrap failed", error)
        }
    }

    private fun awaitApplicationContext(): Context? {
        val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(30)
        while (System.nanoTime() < deadline) {
            val application = runCatching {
                Class.forName("android.app.ActivityThread")
                    .getDeclaredMethod("currentApplication")
                    .invoke(null) as? Application
            }.getOrNull()
            if (application != null) return application.applicationContext
            Thread.sleep(50)
        }
        return null
    }

    private fun resolveArtifacts(classLoader: ClassLoader): StandaloneDockArtifacts? {
        val resources = classLoader.getResources(HookNativeLibraryLocator.STANDALONE_DOCK_RESOURCE)
        while (resources.hasMoreElements()) {
            val apk = HookNativeLibraryLocator.hookApkFromResource(
                resources.nextElement(),
                HookNativeLibraryLocator.STANDALONE_DOCK_RESOURCE,
            ) ?: continue
            if (!apk.isFile) continue
            val installDir = apk.parentFile ?: continue
            for (abiDir in listOf("lib/arm64", "lib/arm64-v8a")) {
                val payload = File(installDir, "$abiDir/libghostlock_aipin.so")
                if (payload.isFile) return StandaloneDockArtifacts(apk, payload)
            }
        }
        return null
    }
}
