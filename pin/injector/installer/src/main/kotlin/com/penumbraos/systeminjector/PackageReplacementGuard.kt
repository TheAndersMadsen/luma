package com.penumbraos.systeminjector

/**
 * Verifies that packages authorized for keep-data replacement are retained settings records
 * rather than live packages. This reads PMS state directly because a normal PackageManager
 * lookup intentionally hides packages after a user-scoped uninstall.
 *
 * PackageSetting.getPkg() is not a liveness signal: Android 12L removes a keep-data-uninstalled
 * package from PMS.mPackages while the retained PackageSetting can still reference its former
 * parsed package. PMS.mPackages is the authoritative in-memory live-package map.
 */
internal object PackageReplacementGuard {
    private const val SYSTEM_SHARED_USER_ID = 1000

    sealed interface PackageState {
        data object Missing : PackageState
        data class Retained(
            val sharedUserId: Int,
            val hasParsedPackage: Boolean = false,
            val baseApkPath: String,
        ) : PackageState
        data class Live(
            val sharedUserId: Int,
            val baseApkPath: String,
        ) : PackageState
        data class InconsistentLive(
            val liveBaseApkPath: String,
            val settingBaseApkPath: String?,
        ) : PackageState
    }

    private data class PmsAccess(
        val lock: Any,
        val settings: Any,
        val livePackages: Any,
    )

    fun validate(
        packageNames: Set<String>,
        approvedReplacementPaths: Map<String, String>,
    ) {
        val access = pmsAccess()
        synchronized(access.lock) {
            validateLocked(
                access.settings,
                access.livePackages,
                packageNames,
                approvedReplacementPaths,
            )
        }
    }

    /**
     * Before the CLI removes any live package, prove the entire staged batch is coherent.
     * Expected live packages must still be system-shared packages; every already-retained sibling
     * must independently contain its exact staged-artifact approval.
     */
    fun validateBeforeUninstall(
        packageNames: Set<String>,
        expectedLivePackagePaths: Map<String, String>,
        approvedReplacementPaths: Map<String, String?>,
    ): Map<String, PackageState> {
        val access = pmsAccess()
        return synchronized(access.lock) {
            val states = packageNames.associateWith { packageName ->
                inspectLocked(access.settings, access.livePackages, packageName)
            }
            validateBeforeUninstallStates(
                states = states,
                expectedLivePackagePaths = expectedLivePackagePaths,
                approvedReplacementPaths = approvedReplacementPaths,
            )
            states
        }
    }

    /** Keep the final validation and packages-backup.xml mutation in one PMS lock scope. */
    fun <T> withValidatedLock(
        packageNames: Set<String>,
        approvedReplacementPaths: Map<String, String>,
        action: () -> T,
    ): T {
        val access = pmsAccess()
        return synchronized(access.lock) {
            validateLocked(
                access.settings,
                access.livePackages,
                packageNames,
                approvedReplacementPaths,
            )
            action()
        }
    }

    private fun validateLocked(
        settings: Any,
        livePackages: Any,
        packageNames: Set<String>,
        approvedReplacementPaths: Map<String, String>,
    ) {
        check(packageNames.containsAll(approvedReplacementPaths.keys)) {
            "Replacement approval contains package outside the staged batch"
        }

        for (packageName in packageNames) {
            val state = inspectLocked(settings, livePackages, packageName)
            val replacementApproved = packageName in approvedReplacementPaths
            val expectedPath = approvedReplacementPaths[packageName]
            check(isAllowed(state, replacementApproved, expectedPath)) {
                "Unsafe package state for $packageName: state=$state, " +
                    "replacementApproved=$replacementApproved, expectedPath=$expectedPath"
            }
        }
    }

    internal fun isAllowed(
        state: PackageState,
        replacementApproved: Boolean,
        expectedBaseApkPath: String? = null,
    ): Boolean {
        return if (replacementApproved) {
            if (state is PackageState.Missing) {
                // The provider separately requires an exact digest-bound approved path and
                // proves that its prior code directory is gone before binding this fresh write.
                true
            } else {
                expectedBaseApkPath != null &&
                    state is PackageState.Retained &&
                    state.sharedUserId == SYSTEM_SHARED_USER_ID &&
                    state.baseApkPath == expectedBaseApkPath
            }
        } else {
            state is PackageState.Missing
        }
    }

    internal fun validateBeforeUninstallStates(
        states: Map<String, PackageState>,
        expectedLivePackagePaths: Map<String, String>,
        approvedReplacementPaths: Map<String, String?>,
    ) {
        check(states.keys.containsAll(expectedLivePackagePaths.keys)) {
            "Expected live package is outside the staged batch"
        }
        check(states.keys.containsAll(approvedReplacementPaths.keys)) {
            "Replacement approval contains package outside the staged batch"
        }
        for ((packageName, state) in states) {
            val expectedLivePath = expectedLivePackagePaths[packageName]
            val replacementApproved = packageName in approvedReplacementPaths
            val expectedReplacementPath = approvedReplacementPaths[packageName]
            check(
                isAllowedBeforeUninstall(
                    state,
                    expectedLivePath,
                    replacementApproved,
                    expectedReplacementPath,
                )
            ) {
                "Unsafe pre-uninstall package state for $packageName: state=$state, " +
                    "expectedLivePath=$expectedLivePath, " +
                    "replacementApproved=$replacementApproved, " +
                    "expectedReplacementPath=$expectedReplacementPath"
            }
        }
    }

    internal fun isAllowedBeforeUninstall(
        state: PackageState,
        expectedLiveBaseApkPath: String?,
        replacementApproved: Boolean,
        expectedReplacementBaseApkPath: String?,
    ): Boolean =
        if (expectedLiveBaseApkPath != null) {
            state is PackageState.Live &&
                state.sharedUserId == SYSTEM_SHARED_USER_ID &&
                state.baseApkPath == expectedLiveBaseApkPath &&
                (
                    !replacementApproved ||
                        expectedReplacementBaseApkPath == null ||
                        state.baseApkPath == expectedReplacementBaseApkPath
                )
        } else if (replacementApproved && expectedReplacementBaseApkPath == null) {
            // A digest-only legacy approval may be upgraded only from the exact retained state
            // captured by this locked snapshot. The provider persists that path before retry.
            state is PackageState.Retained && state.sharedUserId == SYSTEM_SHARED_USER_ID
        } else {
            isAllowed(state, replacementApproved, expectedReplacementBaseApkPath)
        }

    internal fun classifySetting(
        sharedUserId: Int?,
        hasParsedPackage: Boolean,
        settingBaseApkPath: String?,
        liveBaseApkPath: String?,
    ): PackageState {
        if (liveBaseApkPath != null) {
            return if (
                sharedUserId == null ||
                settingBaseApkPath == null ||
                settingBaseApkPath != liveBaseApkPath
            ) {
                PackageState.InconsistentLive(liveBaseApkPath, settingBaseApkPath)
            } else {
                PackageState.Live(sharedUserId, liveBaseApkPath)
            }
        }
        return if (sharedUserId == null || settingBaseApkPath == null) {
            PackageState.Missing
        } else {
            PackageState.Retained(sharedUserId, hasParsedPackage, settingBaseApkPath)
        }
    }

    private fun pmsAccess(): PmsAccess {
        val serviceManager = Class.forName("android.os.ServiceManager")
        val getService = serviceManager.getDeclaredMethod("getService", String::class.java)
        val packageManagerService = getService.invoke(null, "package")
            ?: throw IllegalStateException("PackageManagerService is unavailable")
        val packageManagerLock = readDeclaredField(packageManagerService, "mLock")
            ?: throw IllegalStateException("PMS.mLock is unavailable")
        val settings = readDeclaredField(packageManagerService, "mSettings")
            ?: throw IllegalStateException("PMS.mSettings is unavailable")
        val livePackages = readDeclaredField(packageManagerService, "mPackages")
            ?: throw IllegalStateException("PMS.mPackages is unavailable")
        return PmsAccess(packageManagerLock, settings, livePackages)
    }

    internal fun inspectLocked(
        settings: Any,
        livePackages: Any,
        packageName: String,
    ): PackageState {
        val settingsPackages = readDeclaredField(settings, "mPackages")
            ?: throw IllegalStateException("Settings.mPackages is unavailable")
        // PMS.mPackages is authoritative for liveness. Read it first so a live package with a
        // missing/inconsistent Settings entry can never be admitted as a fresh package.
        val livePackage = mapValue(livePackages, packageName)
        val liveBaseApkPath = livePackage?.let {
            invokeNoArg(it, "getBaseApkPath") as? String
                ?: throw IllegalStateException("Live package has no base APK path")
        }
        val packageSetting = mapValue(settingsPackages, packageName)
            ?: return classifySetting(
                sharedUserId = null,
                hasParsedPackage = false,
                settingBaseApkPath = null,
                liveBaseApkPath = liveBaseApkPath,
            )
        val sharedUserId = (invokeNoArg(packageSetting, "getSharedUserId") as? Int)
            ?: throw IllegalStateException("PackageSetting.getSharedUserId() is unavailable")
        val parsedPackage = invokeNoArg(packageSetting, "getPkg")
        val settingPath = invokeNoArg(packageSetting, "getPathString") as? String
            ?: throw IllegalStateException("PackageSetting.getPathString() is unavailable")
        val settingBaseApkPath = if (settingPath.endsWith(".apk")) {
            settingPath
        } else {
            "$settingPath/base.apk"
        }
        return classifySetting(
            sharedUserId = sharedUserId,
            hasParsedPackage = parsedPackage != null,
            settingBaseApkPath = settingBaseApkPath,
            liveBaseApkPath = liveBaseApkPath,
        )
    }

    private fun mapValue(map: Any, key: String): Any? {
        val getMethod = map.javaClass.getMethod("get", Any::class.java).apply {
            isAccessible = true
        }
        return getMethod.invoke(map, key)
    }

    private fun readDeclaredField(target: Any, fieldName: String): Any? {
        var current: Class<*>? = target.javaClass
        while (current != null) {
            try {
                return current.getDeclaredField(fieldName).apply { isAccessible = true }.get(target)
            } catch (_: NoSuchFieldException) {
                current = current.superclass
            }
        }
        return null
    }

    private fun invokeNoArg(target: Any, methodName: String): Any? {
        var current: Class<*>? = target.javaClass
        while (current != null) {
            try {
                return current.getDeclaredMethod(methodName).apply { isAccessible = true }.invoke(target)
            } catch (_: NoSuchMethodException) {
                current = current.superclass
            }
        }
        throw NoSuchMethodException("Method $methodName not found on ${target.javaClass.name}")
    }
}
