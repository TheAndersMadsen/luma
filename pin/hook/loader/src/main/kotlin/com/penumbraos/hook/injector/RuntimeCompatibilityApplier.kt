package com.penumbraos.hook.injector

import android.util.Log

/**
 * Applies Luma's runtime compatibility configuration to Package Manager's
 * in-memory representation of a known stock package.
 *
 * Runs inside system_server (UID 1000). No native code, AMS interception, or
 * binder wrapper is involved. It uses reflection against PMS's live objects.
 *
 * How it works:
 *   PMS parses all installed packages at boot. The parsed data lives in two maps:
 *     - PMS.mPackages: WatchedArrayMap<String, AndroidPackage>
 *       AndroidPackage is actually ParsingPackageImpl which has:
 *         - setAppComponentFactory(String), public method (line 2723)
 *     - PMS.mSettings.mPackages: WatchedArrayMap<String, PackageSetting>
 *       PackageSetting has:
 *         - getPkgState(), public, returns PackageStateUnserialized (line 436)
 *         - PackageStateUnserialized.setUsesLibraryFiles(List<String>), public (line 187)
 *
 *   PMS's snapshot mechanism (ComputerTracker/ComputerEngine) does shallow copies:
 *   the WatchedArrayMap itself is copied (new key→value reference table), but the
 *   AndroidPackage and PackageSetting objects pointed to by those references are
 *   NOT duplicated. They are the same object instances shared between live and
 *   snapshot views. PackageStateUnserialized (nested inside PackageSetting) is also
 *   shared. Mutations to setAppComponentFactory() or setUsesLibraryFiles() are
 *   therefore immediately visible to all PMS code paths that read from either the
 *   live map or any existing snapshot.
 *
 *   Reversible: all mutations are in-memory only. On reboot, PMS re-parses
 *   packages.xml and APK manifests from disk, restoring original
 *   appComponentFactory and usesLibraryFiles values. The loader must run every
 *   boot to re-apply its changes. This is intentional: disk writes
 *   would require persistent privileged writes and are fragile across OTA updates.
 *
 * Safety:
 *   - All reflection is wrapped in try/catch. Failures are logged and swallowed.
 *   - init() failure means applyTo() becomes a no-op.
 *   - If the Compatibility Layer APK is unavailable, application stops cleanly.
 *   - system_server never crashes from our code.
 *
 * Android 12L (API 32) AOSP android-12.1.0_r1.
 */
object RuntimeCompatibilityApplier {

    private const val TAG = "LumaCompatibility"
    private const val COMPATIBILITY_APK_PACKAGE = "com.penumbraos.hook"
    private const val COMPATIBILITY_FACTORY_CLASS = "com.penumbraos.hook.HookComponentFactory"

    @Volatile
    var isInitialized = false
        private set

    // Cached references from init()
    private var pmsPackages: Any? = null      // WatchedArrayMap<String, AndroidPackage>
    private var settingsPackages: Any? = null  // WatchedArrayMap<String, PackageSetting>
    private var mapGetMethod: java.lang.reflect.Method? = null  // WatchedArrayMap.get(Object)

    @Synchronized
    fun ensureInitialized() {
        if (isInitialized) return

        try {
            clearCachedState()
            init()
            isInitialized = true
            Log.w(TAG, "RuntimeCompatibilityApplier initialized")
        } catch (t: Throwable) {
            clearCachedState()
            Log.e(TAG, "RuntimeCompatibilityApplier initialization failed", t)
        }
    }

    private fun clearCachedState() {
        isInitialized = false
        pmsPackages = null
        settingsPackages = null
        mapGetMethod = null
    }

    /**
     * Apply the Compatibility Layer to the target package's PMS data.
     *
     * After calling this, the NEXT launch of [packageName] will:
     *   1. Have the Compatibility Layer APK on its classpath (via sharedLibraryFiles)
     *   2. Use HookComponentFactory as its appComponentFactory
     *
     * The caller is responsible for force-stopping and relaunching the target.
     *
     * Returns true if compatibility was configured successfully.
     */
    fun applyTo(packageName: String): Boolean {
        if (!isInitialized) {
            Log.e(TAG, "Not initialized, cannot apply compatibility")
            return false
        }

        try {
            return applyCompatibility(packageName)
        } catch (t: Throwable) {
            Log.e(TAG, "applyTo($packageName) failed", t)
            return false
        }
    }

    // -----------------------------------------------------------------------
    // Initialization
    // -----------------------------------------------------------------------

    private fun init() {
        // In Android 12L, PMS extends IPackageManager.Stub directly.
        // ServiceManager.getService("package") returns the PMS Binder object itself
        // (not a proxy) when called from within system_server.
        //
        // ServiceManager is on the boot classpath (framework.jar), so our APK's
        // classloader can find it without any special classloader tricks.
        val serviceManager = Class.forName("android.os.ServiceManager")
        val getService = serviceManager.getDeclaredMethod("getService", String::class.java)
        val pms = getService.invoke(null, "package")
            ?: throw RuntimeException("ServiceManager.getService('package') returned null")
        Log.w(TAG, "Got PMS: ${pms.javaClass.name}")

        // PMS.mPackages, WatchedArrayMap<String, AndroidPackage> (line 873)
        val mPackagesField = pms.javaClass.getDeclaredField("mPackages")
        mPackagesField.isAccessible = true
        pmsPackages = mPackagesField.get(pms)
            ?: throw RuntimeException("PMS.mPackages is null")
        Log.w(TAG, "Got PMS.mPackages: ${pmsPackages!!.javaClass.name}")

        // PMS.mSettings, Settings (line 923)
        val mSettingsField = pms.javaClass.getDeclaredField("mSettings")
        mSettingsField.isAccessible = true
        val settings = mSettingsField.get(pms)
            ?: throw RuntimeException("PMS.mSettings is null")

        // Settings.mPackages, WatchedArrayMap<String, PackageSetting> (line 368)
        val settingsMPackagesField = settings.javaClass.getDeclaredField("mPackages")
        settingsMPackagesField.isAccessible = true
        settingsPackages = settingsMPackagesField.get(settings)
            ?: throw RuntimeException("Settings.mPackages is null")
        Log.w(TAG, "Got Settings.mPackages: ${settingsPackages!!.javaClass.name}")

        // Cache the get() method on WatchedArrayMap (extends ArrayMap which has get(Object))
        mapGetMethod = pmsPackages!!.javaClass.getMethod("get", Any::class.java)
        mapGetMethod!!.isAccessible = true

        Log.w(TAG, "RuntimeCompatibilityApplier init complete")
    }

    // -----------------------------------------------------------------------
    // Compatibility application
    // -----------------------------------------------------------------------

    private fun applyCompatibility(packageName: String): Boolean {
        val compatibilityApkPath = findCompatibilityApkPath()
        if (compatibilityApkPath == null) {
            Log.e(TAG, "Compatibility Layer APK not found on disk; stopping")
            return false
        }

        Log.w(TAG, "=== APPLYING COMPATIBILITY to $packageName ===")
        Log.w(TAG, "  Compatibility Layer APK: $compatibilityApkPath")

        // 1. Mutate AndroidPackage (ParsingPackageImpl), set appComponentFactory
        val androidPackage = mapGetMethod!!.invoke(pmsPackages, packageName)
        if (androidPackage == null) {
            Log.e(TAG, "  Package '$packageName' not found in PMS.mPackages")
            return false
        }
        Log.w(TAG, "  AndroidPackage class: ${androidPackage.javaClass.name}")

        // Save original appComponentFactory for logging
        val getFactory = androidPackage.javaClass.getMethod("getAppComponentFactory")
        val originalFactory = getFactory.invoke(androidPackage) as? String ?: ""
        Log.w(TAG, "  Original appComponentFactory: '$originalFactory'")

        // Set our factory
        val setFactory = androidPackage.javaClass.getMethod(
            "setAppComponentFactory", String::class.java
        )
        setFactory.invoke(androidPackage, COMPATIBILITY_FACTORY_CLASS)
        Log.w(TAG, "  Set appComponentFactory -> $COMPATIBILITY_FACTORY_CLASS")

        // 2. Mutate PackageSetting, add the Compatibility Layer APK to usesLibraryFiles
        val packageSetting = mapGetMethod!!.invoke(settingsPackages, packageName)
        if (packageSetting == null) {
            Log.e(TAG, "  Package '$packageName' not found in Settings.mPackages")
            // appComponentFactory was already set but without the APK on classpath
            // The compatibility factory won't be found, so the app would crash.
            // Revert appComponentFactory.
            setFactory.invoke(androidPackage, originalFactory)
            Log.e(TAG, "  Reverted appComponentFactory to original")
            return false
        }

        // PackageSetting.getPkgState(), public method returning PackageStateUnserialized
        //
        // The appComponentFactory has already been mutated above. Any failure
        // in the remaining steps must revert it so the target app does not
        // crash on next launch with a ClassNotFoundException for the
        // compatibility factory that is not on its classpath.
        val getPkgState = packageSetting.javaClass.getMethod("getPkgState")
        val pkgState = getPkgState.invoke(packageSetting)
        if (pkgState == null) {
            Log.e(TAG, "  PackageSetting.getPkgState() returned null for $packageName")
            setFactory.invoke(androidPackage, originalFactory)
            Log.e(TAG, "  Reverted appComponentFactory to original")
            return false
        }

        // PackageStateUnserialized.getUsesLibraryFiles(), returns List<String>?
        val getLibFiles = pkgState.javaClass.getMethod("getUsesLibraryFiles")
        @Suppress("UNCHECKED_CAST")
        val existingLibFiles = getLibFiles.invoke(pkgState) as? List<String>
        if (existingLibFiles == null) {
            Log.e(TAG, "  getUsesLibraryFiles() returned null for $packageName")
            setFactory.invoke(androidPackage, originalFactory)
            Log.e(TAG, "  Reverted appComponentFactory to original")
            return false
        }

        // Only add if not already present
        if (compatibilityApkPath !in existingLibFiles) {
            val newLibFiles = ArrayList(existingLibFiles)
            newLibFiles.add(compatibilityApkPath)

            // PackageStateUnserialized.setUsesLibraryFiles(List<String>), public
            val setLibFiles = pkgState.javaClass.getMethod(
                "setUsesLibraryFiles", List::class.java
            )
            setLibFiles.invoke(pkgState, newLibFiles)
            Log.w(TAG, "  Added to usesLibraryFiles: $compatibilityApkPath")
            Log.w(TAG, "  Full usesLibraryFiles: $newLibFiles")
        } else {
            Log.w(TAG, "  Compatibility Layer APK already in usesLibraryFiles")
        }

        Log.w(TAG, "=== Compatibility configured for $packageName ===")
        Log.w(TAG, "  Restart the target to activate.")
        return true
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    /**
     * Look up the Compatibility Layer APK's base path from PMS's in-memory data.
     */
    private fun findCompatibilityApkPath(): String? {
        val compatibilityPackage = mapGetMethod!!.invoke(pmsPackages, COMPATIBILITY_APK_PACKAGE)
        if (compatibilityPackage == null) {
            Log.e(TAG, "Compatibility Layer package '$COMPATIBILITY_APK_PACKAGE' not found in PMS.mPackages")
            return null
        }

        return try {
            val getPath = compatibilityPackage.javaClass.getMethod("getBaseApkPath")
            val path = getPath.invoke(compatibilityPackage) as? String
            if (path != null) {
                Log.w(TAG, "Compatibility Layer APK path from PMS: $path")
            } else {
                Log.e(TAG, "getBaseApkPath() returned null for $COMPATIBILITY_APK_PACKAGE")
            }
            path
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to get base APK path for $COMPATIBILITY_APK_PACKAGE", t)
            null
        }
    }
}
