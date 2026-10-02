package com.penumbraos.systeminjector.runtimepolicy

import android.content.Context
import android.content.pm.ApplicationInfo
import android.util.Log

object ServerLaunchPatch {
    private const val TAG = "RuntimePolicy"
    private const val TARGET_SEINFO_BASE = "platform"
    private const val SHARED_USER_ID_SYSTEM = 1000

    sealed interface Result {
        data class Applied(
            val packageName: String,
            val baseSeInfo: String?,
            val overrideBefore: String?,
            val effectiveBefore: String?,
            val overrideAfter: String?,
            val effectiveAfter: String?,
        ) : Result

        data class AlreadyApplied(
            val packageName: String,
            val baseSeInfo: String?,
            val override: String?,
            val effective: String?,
        ) : Result

        data class PackageMissing(val packageName: String) : Result

        data class NotEligible(
            val packageName: String,
            val sharedUserId: Int,
            val appUid: Int?,
        ) : Result
    }

    fun applyOverride(context: Context, packageName: String): Result {
        val packageSetting = findPackageSetting(packageName) ?: return Result.PackageMissing(packageName)

        val sharedUserId = invokeNoArgInt(packageSetting, "getSharedUserId")
        val appInfo = getApplicationInfo(context, packageName)
        val appUid = appInfo?.uid
        if (sharedUserId != SHARED_USER_ID_SYSTEM || appUid != null && appUid != SHARED_USER_ID_SYSTEM) {
            Log.w(
                TAG,
                "Skipping non-system shared user package $packageName: sharedUserId=$sharedUserId uid=${appUid ?: -1}"
            )
            return Result.NotEligible(packageName, sharedUserId, appUid)
        }

        val pkgState = invokeNoArg(packageSetting, "getPkgState")
            ?: throw IllegalStateException("PackageSetting.getPkgState() returned null")
        val androidPackage = invokeNoArg(packageSetting, "getPkg")

        val baseSeInfo = invokeNoArgString(androidPackage, "getSeInfo")
        val overrideBefore = invokeNoArgString(pkgState, "getOverrideSeInfo")
        val effectiveBefore = overrideBefore ?: baseSeInfo
        logPackageStateSnapshot(
            context = context,
            packageName = packageName,
            phase = "before override",
            baseSeInfo = baseSeInfo,
            overrideSeInfo = overrideBefore,
            effectiveSeInfo = effectiveBefore,
        )

        if (overrideBefore == TARGET_SEINFO_BASE) {
            return Result.AlreadyApplied(packageName, baseSeInfo, overrideBefore, effectiveBefore)
        }

        invokeMethod(pkgState, "setOverrideSeInfo", arrayOf(String::class.java), arrayOf(TARGET_SEINFO_BASE))

        val overrideAfter = invokeNoArgString(pkgState, "getOverrideSeInfo")
        val effectiveAfter = overrideAfter ?: baseSeInfo

        Log.w(
            TAG,
            "Applied PackageState override for $packageName: " +
                "base=${baseSeInfo ?: "<null>"}, " +
                "overrideBefore=${overrideBefore ?: "<null>"}, " +
                "overrideAfter=${overrideAfter ?: "<null>"}"
        )

        logPackageStateSnapshot(
            context = context,
            packageName = packageName,
            phase = "after override",
            baseSeInfo = baseSeInfo,
            overrideSeInfo = overrideAfter,
            effectiveSeInfo = effectiveAfter,
        )
        logGeneratedApplicationInfo(context, packageName)

        return Result.Applied(
            packageName = packageName,
            baseSeInfo = baseSeInfo,
            overrideBefore = overrideBefore,
            effectiveBefore = effectiveBefore,
            overrideAfter = overrideAfter,
            effectiveAfter = effectiveAfter,
        )
    }

    private fun findPackageSetting(packageName: String): Any? {
        val serviceManager = Class.forName("android.os.ServiceManager")
        val getService = serviceManager.getDeclaredMethod("getService", String::class.java)
        val pms = getService.invoke(null, "package") ?: return null

        val settings = readDeclaredField(pms, "mSettings") ?: return null
        val settingsPackages = readDeclaredField(settings, "mPackages") ?: return null
        val getMethod = settingsPackages.javaClass.getMethod("get", Any::class.java).apply {
            isAccessible = true
        }
        return getMethod.invoke(settingsPackages, packageName)
    }

    private fun getApplicationInfo(context: Context, packageName: String): ApplicationInfo? {
        return try {
            context.packageManager.getApplicationInfo(packageName, 0)
        } catch (_: Throwable) {
            null
        }
    }

    private fun logGeneratedApplicationInfo(context: Context, packageName: String) {
        try {
            val appInfo = context.packageManager.getApplicationInfo(packageName, 0)
            val seInfo = readPublicStringField(appInfo, "seInfo")
            val seInfoUser = readPublicStringField(appInfo, "seInfoUser")
            Log.w(
                TAG,
                "PackageManager ApplicationInfo after override: " +
                    "package=${appInfo.packageName}, " +
                    "uid=${appInfo.uid}, " +
                    "seInfo=${seInfo ?: "<null>"}, " +
                    "seInfoUser=${seInfoUser ?: "<null>"}"
            )
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to read ApplicationInfo after override for $packageName", t)
        }
    }

    private fun logPackageStateSnapshot(
        context: Context,
        packageName: String,
        phase: String,
        baseSeInfo: String?,
        overrideSeInfo: String?,
        effectiveSeInfo: String?,
    ) {
        val appInfo = getApplicationInfo(context, packageName)
        val appSeInfo = appInfo?.let { readPublicStringField(it, "seInfo") }
        val appSeInfoUser = appInfo?.let { readPublicStringField(it, "seInfoUser") }
        Log.w(
            TAG,
            "PackageState $phase: " +
                "package=$packageName, " +
                "baseSeInfo=${baseSeInfo ?: "<null>"}, " +
                "overrideSeInfo=${overrideSeInfo ?: "<null>"}, " +
                "effectiveSeInfo=${effectiveSeInfo ?: "<null>"}, " +
                "appSeInfo=${appSeInfo ?: "<null>"}, " +
                "appSeInfoUser=${appSeInfoUser ?: "<null>"}, " +
                "uid=${appInfo?.uid ?: -1}"
        )
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

    private fun invokeNoArg(target: Any?, methodName: String): Any? {
        if (target == null) return null
        var current: Class<*>? = target.javaClass
        while (current != null) {
            try {
                val method = current.getDeclaredMethod(methodName)
                method.isAccessible = true
                return method.invoke(target)
            } catch (_: NoSuchMethodException) {
                current = current.superclass
            }
        }
        return null
    }

    private fun invokeNoArgString(target: Any?, methodName: String): String? {
        return invokeNoArg(target, methodName) as? String
    }

    private fun invokeNoArgInt(target: Any?, methodName: String): Int {
        return (invokeNoArg(target, methodName) as? Int) ?: -1
    }

    private fun invokeMethod(target: Any, methodName: String, parameterTypes: Array<Class<*>>, args: Array<Any?>): Any? {
        var current: Class<*>? = target.javaClass
        while (current != null) {
            try {
                val method = current.getDeclaredMethod(methodName, *parameterTypes)
                method.isAccessible = true
                return method.invoke(target, *args)
            } catch (_: NoSuchMethodException) {
                current = current.superclass
            }
        }
        throw NoSuchMethodException("Method $methodName not found on ${target.javaClass.name}")
    }

    private fun readPublicStringField(target: Any, fieldName: String): String? {
        return try {
            target.javaClass.getField(fieldName).get(target) as? String
        } catch (_: NoSuchFieldException) {
            null
        }
    }
}
