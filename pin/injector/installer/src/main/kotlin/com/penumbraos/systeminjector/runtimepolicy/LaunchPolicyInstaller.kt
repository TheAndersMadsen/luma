package com.penumbraos.systeminjector.runtimepolicy

import android.content.Context
import android.util.Log

object LaunchPolicyInstaller {
    private const val TAG = "RuntimePolicy"
    private const val PROP_DISABLE = "debug.penumbra.runtimepolicy.disable"

    data class RefreshResult(
        val successfulPackages: Set<String>,
        val failedPackages: Set<String>,
        val globalFailure: String? = null,
    ) {
        fun succeededFor(requiredPackages: Set<String>): Boolean =
            globalFailure == null && successfulPackages.containsAll(requiredPackages)
    }

    fun refreshPolicies(context: Context): RefreshResult {
        val successfulPackages = linkedSetOf<String>()
        val failedPackages = linkedSetOf<String>()
        return try {
            if (isDisabled()) {
                Log.w(TAG, "Runtime policy disabled via $PROP_DISABLE")
                return RefreshResult(
                    successfulPackages = emptySet(),
                    failedPackages = emptySet(),
                    globalFailure = "Runtime policy is disabled",
                )
            }

            val trackedPackages = PolicyRegistry.loadTrackedPackages(context)
            if (trackedPackages.isEmpty()) {
                Log.w(TAG, "No tracked packages registered")
                return RefreshResult(emptySet(), emptySet())
            }

            Log.w(TAG, "Refreshing runtime policy for ${trackedPackages.size} tracked package(s)")
            val keptPackages = linkedSetOf<String>()

            for (packageName in trackedPackages.sorted()) {
                val launchPolicyApplied = when (val result = ServerLaunchPatch.applyOverride(context, packageName)) {
                    is ServerLaunchPatch.Result.Applied -> {
                        Log.w(
                            TAG,
                            "Applied seInfo override for ${result.packageName}: " +
                                "base=${result.baseSeInfo ?: "<null>"}, " +
                                "overrideBefore=${result.overrideBefore ?: "<null>"}, " +
                                "effectiveBefore=${result.effectiveBefore ?: "<null>"}, " +
                                "overrideAfter=${result.overrideAfter ?: "<null>"}, " +
                                "effectiveAfter=${result.effectiveAfter ?: "<null>"}"
                        )
                        true
                    }
                    is ServerLaunchPatch.Result.AlreadyApplied -> {
                        Log.w(
                            TAG,
                            "seInfo override already set for ${result.packageName}: " +
                                "base=${result.baseSeInfo ?: "<null>"}, " +
                                "override=${result.override ?: "<null>"}, " +
                                "effective=${result.effective ?: "<null>"}"
                        )
                        true
                    }
                    is ServerLaunchPatch.Result.PackageMissing -> {
                        Log.w(TAG, "Tracked package missing from PMS: ${result.packageName}")
                        failedPackages.add(packageName)
                        false
                    }
                    is ServerLaunchPatch.Result.NotEligible -> {
                        Log.w(
                            TAG,
                            "Tracked package is no longer installer-managed system app: " +
                                "package=${result.packageName}, sharedUserId=${result.sharedUserId}, uid=${result.appUid ?: -1}"
                        )
                        failedPackages.add(packageName)
                        false
                    }
                }

                if (!launchPolicyApplied) continue

                // App data must be provisioned after the PackageState override.
                // installd derives the directory label from this effective seInfo;
                // doing this first leaves injected shared-system-UID packages with
                // system_data_file, which the resulting system_app process cannot
                // write. createAppData is idempotent and also restores the label on
                // directories Package Manager created before this boot receiver ran.
                when (val provisionResult = AppDataProvisioner.ensureProvisioned(context, packageName)) {
                    is AppDataProvisioner.Result.Applied -> {
                        Log.w(
                            TAG,
                            "Provisioned app data for ${provisionResult.packageName}: " +
                                "userId=${provisionResult.userId}, " +
                                "flags=0x${provisionResult.flags.toString(16)}, " +
                                "appId=${provisionResult.appId}, " +
                                "targetSdkVersion=${provisionResult.targetSdkVersion}, " +
                                "seInfo=${provisionResult.seInfo}, " +
                                "ceDataInode=${provisionResult.ceDataInode}"
                        )
                        successfulPackages.add(packageName)
                    }
                    is AppDataProvisioner.Result.PackageMissing -> {
                        Log.w(
                            TAG,
                            "Tracked package disappeared before app-data provisioning: ${provisionResult.packageName}"
                        )
                        failedPackages.add(packageName)
                        continue
                    }
                    is AppDataProvisioner.Result.NotEligible -> {
                        Log.w(
                            TAG,
                            "Tracked package became ineligible before app-data provisioning: " +
                                "package=${provisionResult.packageName}, uid=${provisionResult.appUid ?: -1}"
                        )
                        failedPackages.add(packageName)
                        continue
                    }
                    is AppDataProvisioner.Result.Failed -> {
                        // Retain the package so a later boot retries provisioning.
                        // The launch override is still needed even when storage
                        // repair fails, and dropping it would make the app unlaunchable.
                        Log.e(
                            TAG,
                            "App-data provisioning failed for ${provisionResult.packageName}; will retry on boot: " +
                                provisionResult.message,
                            provisionResult.error,
                        )
                        failedPackages.add(packageName)
                    }
                }

                keptPackages.add(packageName)
            }

            if (keptPackages != trackedPackages) {
                if (PolicyRegistry.replaceTrackedPackages(context, keptPackages)) {
                    Log.w(
                        TAG,
                        "Pruned tracked package registry from ${trackedPackages.size} to ${keptPackages.size} entries"
                    )
                }
            }
            RefreshResult(
                successfulPackages = successfulPackages,
                failedPackages = failedPackages,
            )
        } catch (t: Throwable) {
            Log.e(TAG, "Runtime launch policy refresh failed", t)
            RefreshResult(
                successfulPackages = successfulPackages,
                failedPackages = failedPackages,
                globalFailure = t.message ?: t.javaClass.simpleName,
            )
        }
    }

    private fun isDisabled(): Boolean {
        return try {
            val sysPropClass = Class.forName("android.os.SystemProperties")
            val getMethod = sysPropClass.getDeclaredMethod("get", String::class.java, String::class.java)
            val value = getMethod.invoke(null, PROP_DISABLE, "") as String
            value == "1"
        } catch (t: Throwable) {
            Log.w(TAG, "Failed to read $PROP_DISABLE; assuming enabled", t)
            false
        }
    }
}
