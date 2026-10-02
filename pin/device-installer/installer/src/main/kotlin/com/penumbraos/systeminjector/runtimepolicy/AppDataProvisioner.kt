package com.penumbraos.systeminjector.runtimepolicy

import android.content.Context
import android.content.pm.ApplicationInfo
import android.util.Log
import java.io.File

object AppDataProvisioner {
    private const val TAG = "RuntimePolicy"
    private const val TARGET_USER_ID = 0
    private const val FALLBACK_PROVISION_SEINFO = "platform"
    private const val INSTALL_PROVISION_SEINFO = "platform:complete"
    private const val FLAG_STORAGE_DE = 0x1
    private const val FLAG_STORAGE_CE = 0x2
    private const val PER_USER_RANGE = 100000
    private const val SHARED_USER_ID_SYSTEM = 1000

    sealed interface Result {
        data class Applied(
            val packageName: String,
            val userId: Int,
            val flags: Int,
            val appId: Int,
            val targetSdkVersion: Int,
            val seInfo: String,
            val ceDataInode: Long,
        ) : Result

        data class PackageMissing(val packageName: String) : Result

        data class NotEligible(
            val packageName: String,
            val appUid: Int?,
        ) : Result

        data class Failed(
            val packageName: String,
            val message: String,
            val error: Throwable? = null,
        ) : Result
    }

    fun ensureProvisioned(context: Context, packageName: String): Result {
        val appInfo = getApplicationInfo(context, packageName) ?: return Result.PackageMissing(packageName)
        if (appInfo.uid != SHARED_USER_ID_SYSTEM) {
            return Result.NotEligible(packageName, appInfo.uid)
        }

        return ensureProvisioned(
            packageName = packageName,
            uid = appInfo.uid,
            targetSdkVersion = appInfo.targetSdkVersion,
            provisionSeInfo = deriveProvisionSeInfo(appInfo),
            appInfoForLogging = appInfo,
        )
    }

    fun ensureProvisionedForInstall(
        packageName: String,
        uid: Int,
        targetSdkVersion: Int,
    ): Result {
        if (uid != SHARED_USER_ID_SYSTEM) {
            return Result.NotEligible(packageName, uid)
        }

        return ensureProvisioned(
            packageName = packageName,
            uid = uid,
            targetSdkVersion = targetSdkVersion,
            provisionSeInfo = INSTALL_PROVISION_SEINFO,
            appInfoForLogging = null,
        )
    }

    private fun ensureProvisioned(
        packageName: String,
        uid: Int,
        targetSdkVersion: Int,
        provisionSeInfo: String,
        appInfoForLogging: ApplicationInfo?,
    ): Result {
        return try {
            val installer = findInstaller()
                ?: return Result.Failed(packageName, "PMS.mInstaller not found")
            val appId = uid % PER_USER_RANGE
            val flags = FLAG_STORAGE_DE or FLAG_STORAGE_CE
            logProvisioningState("before", packageName, appInfoForLogging, uid, appId, flags, targetSdkVersion, provisionSeInfo)
            val ceDataInode = invokeCreateAppData(
                installer = installer,
                packageName = packageName,
                userId = TARGET_USER_ID,
                flags = flags,
                appId = appId,
                seInfo = provisionSeInfo,
                targetSdkVersion = targetSdkVersion,
            )
            logProvisioningState("after", packageName, appInfoForLogging, uid, appId, flags, targetSdkVersion, provisionSeInfo)
            Result.Applied(
                packageName = packageName,
                userId = TARGET_USER_ID,
                flags = flags,
                appId = appId,
                targetSdkVersion = targetSdkVersion,
                seInfo = provisionSeInfo,
                ceDataInode = ceDataInode,
            )
        } catch (t: Throwable) {
            Log.e(TAG, "App-data provisioning failed for $packageName", t)
            Result.Failed(packageName, t.message ?: t.javaClass.name, t)
        }
    }

    private fun getApplicationInfo(context: Context, packageName: String): ApplicationInfo? {
        return try {
            context.packageManager.getApplicationInfo(packageName, 0)
        } catch (_: Throwable) {
            null
        }
    }

    private fun findInstaller(): Any? {
        val serviceManager = Class.forName("android.os.ServiceManager")
        val getService = serviceManager.getDeclaredMethod("getService", String::class.java)
        val pms = getService.invoke(null, "package") ?: return null
        return readDeclaredField(pms, "mInstaller")
    }

    private fun deriveProvisionSeInfo(appInfo: ApplicationInfo): String {
        val appSeInfo = readPublicStringField(appInfo, "seInfo")
        val appSeInfoUser = readPublicStringField(appInfo, "seInfoUser")
        return when {
            !appSeInfo.isNullOrBlank() && !appSeInfoUser.isNullOrBlank() -> appSeInfo + appSeInfoUser
            !appSeInfo.isNullOrBlank() -> appSeInfo
            else -> FALLBACK_PROVISION_SEINFO
        }
    }

    private fun logProvisioningState(
        phase: String,
        packageName: String,
        appInfo: ApplicationInfo?,
        uid: Int,
        appId: Int,
        flags: Int,
        targetSdkVersion: Int,
        provisionSeInfo: String,
    ) {
        val appSeInfo = appInfo?.let { readPublicStringField(it, "seInfo") }
        val appSeInfoUser = appInfo?.let { readPublicStringField(it, "seInfoUser") }
        val cePath = appInfo?.dataDir
        val dePath = appInfo?.let { readPublicStringField(it, "deviceProtectedDataDir") }
        val ceExists = cePath?.let { File(it).exists() } ?: false
        val deExists = dePath?.let { File(it).exists() } ?: false
        Log.w(
            TAG,
            "App-data provisioning $phase: " +
                "package=$packageName, " +
                "uid=$uid, " +
                "userId=$TARGET_USER_ID, " +
                "appId=$appId, " +
                "flags=0x${flags.toString(16)}, " +
                "targetSdkVersion=$targetSdkVersion, " +
                "seInfoArg=$provisionSeInfo, " +
                "appSeInfo=${appSeInfo ?: "<null>"}, " +
                "appSeInfoUser=${appSeInfoUser ?: "<null>"}, " +
                "cePath=${cePath ?: "<null>"}, " +
                "ceExists=$ceExists, " +
                "dePath=${dePath ?: "<null>"}, " +
                "deExists=$deExists"
        )
    }

    private fun invokeCreateAppData(
        installer: Any,
        packageName: String,
        userId: Int,
        flags: Int,
        appId: Int,
        seInfo: String,
        targetSdkVersion: Int,
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
        ).apply {
            isAccessible = true
        }

        return method.invoke(
            installer,
            null,
            packageName,
            userId,
            flags,
            appId,
            seInfo,
            targetSdkVersion,
        ) as Long
    }

    private fun readDeclaredField(target: Any, fieldName: String): Any? {
        var current: Class<*>? = target.javaClass
        while (current != null) {
            try {
                val field = current.getDeclaredField(fieldName)
                field.isAccessible = true
                return field.get(target)
            } catch (_: NoSuchFieldException) {
                current = current.superclass
            }
        }
        return null
    }

    private fun readPublicStringField(target: Any, fieldName: String): String? {
        return try {
            target.javaClass.getField(fieldName).get(target) as? String
        } catch (_: NoSuchFieldException) {
            null
        }
    }
}
