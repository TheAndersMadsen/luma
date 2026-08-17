package com.penumbraos.hook.injector

import android.content.Context
import android.content.pm.ApplicationInfo

/**
 * Repairs the Server package's runtime policy so it can launch with correct
 * SELinux labels and app data directories.
 *
 * ## Why this repair is needed
 *
 * Apps installed via the exploit (system UID, shared user ID) are not recognized
 * by Android's normal SELinux policy assignment. AMS assigns them seInfo=_app
 * instead of seInfo=platform, which prevents them from accessing system
 * resources, making privileged binder calls, or reading/writing their own
 * /data/user_de/0/ and /data/user/0/ directories.
 *
 * This repair:
 * 1. Reflects into PMS to override the Server's seInfo to "platform"
 * 2. Calls Installer.createAppData() to recreate the data directories with
 *    correct SELinux labels (since the original directories may have been
 *    created with wrong labels or may not exist after a keep-data update)
 *
 * ## When it runs
 *
 * Called at LOCKED_BOOT_COMPLETED (device-encrypted storage phase) and
 * BOOT_COMPLETED (credential-encrypted storage phase) by BootInjectionReceiver,
 * before any target apps or the Server itself are launched.
 *
 * ## Safety
 *
 * Runs only inside system_server. The target name, UID, shared user, seInfo,
 * Android user, and app-data flags are intentionally hardcoded rather than
 * supplied by a broadcast or caller. An ineligible package (wrong UID, wrong
 * shared user, not the exact target) is silently skipped.
 */
object ServerRuntimePolicyRepair {
    internal const val TARGET_PACKAGE = "com.penumbraos.server"
    internal const val SYSTEM_APP_ID = 1000
    internal const val TARGET_SEINFO = "platform"
    internal const val PROVISION_SEINFO = "platform:complete"
    internal const val TARGET_USER_ID = 0
    internal const val DEVICE_ENCRYPTED_FLAG = 0x1
    internal const val CREDENTIAL_ENCRYPTED_FLAG = 0x2

    enum class StoragePhase(val appDataFlags: Int) {
        DEVICE_ENCRYPTED(DEVICE_ENCRYPTED_FLAG),
        CREDENTIAL_ENCRYPTED(CREDENTIAL_ENCRYPTED_FLAG),
    }

    internal data class EligibilitySnapshot(
        val packageName: String,
        val live: Boolean,
        val sharedUserId: Int,
        val appUid: Int?,
    )

    internal fun isEligible(snapshot: EligibilitySnapshot): Boolean =
        snapshot.packageName == TARGET_PACKAGE &&
            snapshot.live &&
            snapshot.sharedUserId == SYSTEM_APP_ID &&
            snapshot.appUid == SYSTEM_APP_ID

    sealed interface Result {
        data class Applied(
            val overrideChanged: Boolean,
            val storagePhase: StoragePhase,
            val appDataFlags: Int,
            val ceDataInode: Long,
            val targetSdkVersion: Int,
        ) : Result

        data object PackageMissing : Result
        data class NotEligible(val sharedUserId: Int, val appUid: Int?) : Result
        data class Failed(val message: String, val error: Throwable? = null) : Result
    }

    fun repair(context: Context, storagePhase: StoragePhase): Result {
        return try {
            val pms = findPackageManagerService()
                ?: return Result.Failed("PackageManagerService is unavailable")
            val lock = readDeclaredField(pms, "mLock")
                ?: return Result.Failed("PMS.mLock is unavailable")
            val settings = readDeclaredField(pms, "mSettings")
                ?: return Result.Failed("PMS.mSettings is unavailable")
            val settingsPackages = readDeclaredField(settings, "mPackages")
                ?: return Result.Failed("Settings.mPackages is unavailable")
            val livePackages = readDeclaredField(pms, "mPackages")
                ?: return Result.Failed("PMS.mPackages is unavailable")
            val appInfoBefore = getApplicationInfo(context)

            val overrideChanged = synchronized(lock) {
                val packageSetting = mapValue(settingsPackages, TARGET_PACKAGE)
                    ?: return Result.PackageMissing
                val livePackage = mapValue(livePackages, TARGET_PACKAGE)
                val sharedUserId = invokeNoArg(packageSetting, "getSharedUserId") as? Int ?: -1
                val snapshot = EligibilitySnapshot(
                    packageName = TARGET_PACKAGE,
                    live = livePackage != null,
                    sharedUserId = sharedUserId,
                    appUid = appInfoBefore?.uid,
                )
                if (!isEligible(snapshot)) {
                    return Result.NotEligible(sharedUserId, appInfoBefore?.uid)
                }

                val packageState = invokeNoArg(packageSetting, "getPkgState")
                    ?: return Result.Failed("PackageSetting.getPkgState() returned null")
                val overrideBefore = invokeNoArg(packageState, "getOverrideSeInfo") as? String
                if (overrideBefore != TARGET_SEINFO) {
                    invokeMethod(
                        packageState,
                        "setOverrideSeInfo",
                        arrayOf(String::class.java),
                        arrayOf(TARGET_SEINFO),
                    )
                }
                val overrideAfter = invokeNoArg(packageState, "getOverrideSeInfo") as? String
                if (overrideAfter != TARGET_SEINFO) {
                    return Result.Failed("Server seInfo override did not apply")
                }
                overrideBefore != TARGET_SEINFO
            }

            val appInfoAfter = getApplicationInfo(context)
                ?: return Result.Failed("Server ApplicationInfo disappeared after policy repair")
            if (appInfoAfter.uid != SYSTEM_APP_ID) {
                return Result.NotEligible(SYSTEM_APP_ID, appInfoAfter.uid)
            }
            val effectiveSeInfo = readPublicStringField(appInfoAfter, "seInfo")
            if (effectiveSeInfo != TARGET_SEINFO) {
                return Result.Failed(
                    "Server ApplicationInfo did not expose the platform seInfo override: " +
                        (effectiveSeInfo ?: "<null>")
                )
            }
            val installer = readDeclaredField(pms, "mInstaller")
                ?: return Result.Failed("PMS.mInstaller is unavailable")
            val ceDataInode = invokeCreateAppData(
                installer,
                appInfoAfter,
                storagePhase.appDataFlags,
            )
            Result.Applied(
                overrideChanged = overrideChanged,
                storagePhase = storagePhase,
                appDataFlags = storagePhase.appDataFlags,
                ceDataInode = ceDataInode,
                targetSdkVersion = appInfoAfter.targetSdkVersion,
            )
        } catch (error: Throwable) {
            Result.Failed(error.message ?: error.javaClass.name, error)
        }
    }

    private fun getApplicationInfo(context: Context): ApplicationInfo? =
        try {
            context.packageManager.getApplicationInfo(TARGET_PACKAGE, 0)
        } catch (_: Throwable) {
            null
        }

    private fun findPackageManagerService(): Any? {
        val serviceManager = Class.forName("android.os.ServiceManager")
        val getService = serviceManager.getDeclaredMethod("getService", String::class.java)
        return getService.invoke(null, "package")
    }

    private fun invokeCreateAppData(
        installer: Any,
        appInfo: ApplicationInfo,
        appDataFlags: Int,
    ): Long {
        val method = installer.javaClass.getMethod(
            "createAppData",
            String::class.java,
            String::class.java,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            String::class.java,
            Int::class.javaPrimitiveType,
        ).apply { isAccessible = true }
        return method.invoke(
            installer,
            null,
            TARGET_PACKAGE,
            TARGET_USER_ID,
            appDataFlags,
            SYSTEM_APP_ID,
            PROVISION_SEINFO,
            appInfo.targetSdkVersion,
        ) as Long
    }

    private fun mapValue(map: Any, key: String): Any? =
        map.javaClass.getMethod("get", Any::class.java).apply {
            isAccessible = true
        }.invoke(map, key)

    private fun readDeclaredField(target: Any, fieldName: String): Any? {
        var current: Class<*>? = target.javaClass
        while (current != null) {
            try {
                return current.getDeclaredField(fieldName).apply {
                    isAccessible = true
                }.get(target)
            } catch (_: NoSuchFieldException) {
                current = current.superclass
            }
        }
        return null
    }

    private fun readPublicStringField(target: Any, fieldName: String): String? =
        try {
            target.javaClass.getField(fieldName).get(target) as? String
        } catch (_: NoSuchFieldException) {
            null
        }

    private fun invokeNoArg(target: Any, methodName: String): Any? {
        var current: Class<*>? = target.javaClass
        while (current != null) {
            try {
                return current.getDeclaredMethod(methodName).apply {
                    isAccessible = true
                }.invoke(target)
            } catch (_: NoSuchMethodException) {
                current = current.superclass
            }
        }
        throw NoSuchMethodException("Method $methodName not found on ${target.javaClass.name}")
    }

    private fun invokeMethod(
        target: Any,
        methodName: String,
        parameterTypes: Array<Class<*>>,
        arguments: Array<Any?>,
    ): Any? {
        var current: Class<*>? = target.javaClass
        while (current != null) {
            try {
                return current.getDeclaredMethod(methodName, *parameterTypes).apply {
                    isAccessible = true
                }.invoke(target, *arguments)
            } catch (_: NoSuchMethodException) {
                current = current.superclass
            }
        }
        throw NoSuchMethodException("Method $methodName not found on ${target.javaClass.name}")
    }
}
