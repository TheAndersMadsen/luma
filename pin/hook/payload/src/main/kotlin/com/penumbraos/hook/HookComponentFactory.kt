package com.penumbraos.hook

import android.app.AppComponentFactory
import android.app.Application
import android.util.Log
import com.penumbraos.stockaibus.contract.StockSymbols
import com.penumbraos.stockaibus.contract.TierASymbols
import java.io.File
import java.net.URI
import java.net.URL

internal enum class HookClassification {
    REQUIRED_TRANSPORT,
    VERIFIED_COMPATIBILITY,
    CONDITIONAL_COMPATIBILITY,
    DIAGNOSTICS,
}

internal class HookModuleDescriptor(
    val id: String,
    val targetPackage: String,
    val probeClasses: Set<String>,
    val classification: HookClassification,
    val install: (ClassLoader) -> Unit,
) {
    init {
        require(id.isNotBlank())
        require(targetPackage.isNotBlank())
        require(probeClasses.isNotEmpty() && probeClasses.none(String::isBlank))
    }

    fun matches(packageName: String, classAvailable: (String) -> Boolean): Boolean =
        packageName == targetPackage && probeClasses.any(classAvailable)
}

internal object HookNativeLibraryLocator {
    const val NATIVE_RESOURCE = "lib/arm64-v8a/libaliuhook.so"
    val REQUIRED_NATIVE_LIBRARIES = listOf(
        "libc++_shared.so",
        "liblsplant.so",
        "libaliuhook.so",
    )

    private const val DATA_APP_ROOT = "/data/app"
    private const val HOOK_PACKAGE = "com.penumbraos.hook"

    /**
     * Resolve the installed hook APK from the unique AliuHook resource exposed by
     * the target's injected PathClassLoader. Android 12 package installs normally
     * live below a randomized `/data/app/~~.../<package>-.../base.apk` parent, so
     * a fixed top-level directory probe is insufficient after a package update.
     */
    fun hookApkFromNativeResource(resource: URL): File? {
        val external = resource.toExternalForm()
        if (!external.startsWith("jar:")) return null
        val separator = external.indexOf("!/")
        if (separator <= "jar:".length) return null
        if (external.substring(separator + 2) != NATIVE_RESOURCE) return null

        val jarUri = runCatching { URI(external.substring("jar:".length, separator)) }
            .getOrNull() ?: return null
        if (
            jarUri.scheme != "file" ||
            jarUri.authority != null ||
            jarUri.query != null ||
            jarUri.fragment != null
        ) {
            return null
        }

        val apk = runCatching { File(jarUri).canonicalFile }.getOrNull() ?: return null
        val dataApp = runCatching { File(DATA_APP_ROOT).canonicalFile }.getOrNull() ?: return null
        if (apk.name != "base.apk") return null
        if (!apk.path.startsWith(dataApp.path + File.separator)) return null

        val installDir = apk.parentFile ?: return null
        if (
            installDir.name != "$HOOK_PACKAGE-injected" &&
            !installDir.name.startsWith("$HOOK_PACKAGE-")
        ) {
            return null
        }
        return apk
    }

    fun containsRequiredLibraries(directory: File): Boolean =
        REQUIRED_NATIVE_LIBRARIES.all { library -> File(directory, library).isFile }
}

/**
 * Entry point for hook code running inside the target process.
 *
 * ## How this class is loaded into target processes
 *
 * At boot, the Injector (running in system_server) mutates PMS in-memory data
 * for each target package:
 *   1. Sets the target's appComponentFactory to this class's fully-qualified name
 *   2. Adds the Hook APK's base.apk path to the target's usesLibraryFiles list
 *
 * When Android later launches the target app, the framework:
 *   - Creates a PathClassLoader with both the target APK and the Hook APK on its
 *     classpath (because of usesLibraryFiles)
 *   - Instantiates the appComponentFactory class from that combined classpath
 *   - Calls instantiateApplication() on it before Application.attachBaseContext()
 *
 * This means HookComponentFactory runs INSIDE the target process, with access
 * to both the Hook's classes and the target's classes.
 *
 * ## Probe class matching
 *
 * Hook modules are registered in [HOOK_MODULES]. Each module declares a "probe"
 * class that must exist on the target's classloader for the module to activate.
 * The probe is loaded from the TARGET's classloader, not the Hook's. If the
 * target APK contains that class, the hook module applies to it. This allows a
 * single Hook APK to be injected into 14+ different target APKs, with only the
 * relevant modules activating in each process.
 *
 * ## Safety
 *
 * All hook initialization is wrapped in try/catch. If anything fails (native
 * library loading, module installation), the app still starts normally via
 * createApplication(). The app runs unhooked rather than crashing.
 */
class HookComponentFactory : AppComponentFactory() {

    companion object {
        const val TAG = "PenumbraHook"
        const val HOOK_PACKAGE = "com.penumbraos.hook"

        /**
         * Exact package-scoped registry. Probe classes are a firmware-shape
         * check inside the already matched package, never the package identity.
         */
        internal val HOOK_MODULES: List<HookModuleDescriptor> = listOf(
            module(
                "memfault-zero-egress",
                TierASymbols.Packages.MEMFAULT_USAGE_REPORTER,
                "com.memfault.bort.reporting.RemoteMetricsService",
                HookClassification.CONDITIONAL_COMPATIBILITY,
                MemfaultReportingHooks::install,
            ),
            module(
                "ironman-runtime",
                StockSymbols.Ironman.PACKAGE,
                StockSymbols.Ironman.MAIN_APPLICATION_CLASS,
                HookClassification.REQUIRED_TRANSPORT,
                IronmanHooks::install,
            ),
            module(
                "stock-tts",
                TierASymbols.Packages.VOICE_TTS,
                "humane.voice.tts.HumaneTTSService",
                HookClassification.VERIFIED_COMPATIBILITY,
                HumaneTtsHooks::install,
            ),
            // Safety: disabled because ContactsHooks exposes a reset/plaintext decoder.
            // "humaneinternal.system.contacts.ContactsManager" to ContactsHooks::install,
            module(
                "dialer-compatibility",
                StockSymbols.Dialer.PACKAGE,
                "humane.system.TelephonyServices",
                HookClassification.CONDITIONAL_COMPATIBILITY,
                TelephonyCompatibilityHooks::install,
            ),
            module(
                "message-status-observation",
                StockSymbols.Messages.PACKAGE,
                StockSymbols.Messages.PERSISTENT_MESSAGE_STORE_CLASS,
                HookClassification.CONDITIONAL_COMPATIBILITY,
                MessageStatusHooks::install,
            ),
            module(
                "message-semantic-index-safety",
                StockSymbols.Messages.PACKAGE,
                StockSymbols.Messages.SEMANTIC_INDEX_CLASS,
                HookClassification.VERIFIED_COMPATIBILITY,
                SemanticIndexSafetyHooks::install,
            ),
            // Safety: disabled because InboundFilteringHooks bypasses the address-book trust gate.
            // "humane.addressbook.AddressBookAccess" to InboundFilteringHooks::install,
            // Safety: disabled because OnboardingHooks installs opaque stubs and a fake DAC.
            // "humane.experience.onboarding.OnboardingExperience" to OnboardingHooks::install,
            module(
                "onboarding-clone-transport",
                TierASymbols.Packages.ONBOARDING,
                "humane.experience.onboarding.OnboardingExperience",
                HookClassification.REQUIRED_TRANSPORT,
                CarryOnboardingTransportHooks::install,
            ),
            module(
                "photography-compatibility",
                StockSymbols.Photography.PACKAGE,
                "system.PhotographyExperienceApplication",
                HookClassification.CONDITIONAL_COMPATIBILITY,
                PhotographyHooks::install,
            ),
            module(
                "krypto-local-transport",
                StockSymbols.Krypto.PACKAGE,
                "humaneinternal.system.krypto.KryptoService",
                HookClassification.REQUIRED_TRANSPORT,
                KryptoHooks::install,
            ),
            module(
                "system-navigation-compatibility",
                TierASymbols.Packages.SYSTEM_NAVIGATION,
                "humane.experience.systemnavigation.SystemNavigationExperience",
                HookClassification.CONDITIONAL_COMPATIBILITY,
                SystemNavigationHooks::install,
            ),
            module(
                "settings-compatibility",
                StockSymbols.Settings.PACKAGE,
                StockSymbols.Settings.SETTINGS_EXPERIENCE_CLASS,
                HookClassification.CONDITIONAL_COMPATIBILITY,
                SettingsHooks::install,
            ),
            module(
                "esim-lpa-observation",
                StockSymbols.EsimLpa.PACKAGE,
                StockSymbols.EsimLpa.FACTORY_SERVICE_CLASS,
                HookClassification.CONDITIONAL_COMPATIBILITY,
                EsimLpaHooks::install,
            ),
            module(
                "music-provider-compatibility",
                StockSymbols.Music.PACKAGE,
                "humane.experience.music.MusicExperience",
                HookClassification.VERIFIED_COMPATIBILITY,
                MusicHooks::install,
            ),
            module(
                "food-provider-compatibility",
                StockSymbols.Food.PACKAGE,
                "humane.experience.food.FoodExperience",
                HookClassification.CONDITIONAL_COMPATIBILITY,
                FoodHooks::install,
            ),
            // `humane.experience.ExperienceApplication` exists in many stock
            // APKs. Exact package matching is therefore the load-bearing gate.
            // TickleHooks already installs its launcher child, so no duplicate
            // ScrollView registration is needed.
            module(
                "tickle-compatibility",
                StockSymbols.Tickle.PACKAGE,
                StockSymbols.ExperienceRuntime.EXPERIENCE_APPLICATION_CLASS,
                HookClassification.CONDITIONAL_COMPATIBILITY,
                TickleHooks::install,
            ),
        )

        private fun module(
            id: String,
            targetPackage: String,
            probeClass: String,
            classification: HookClassification,
            install: (ClassLoader) -> Unit,
        ) = HookModuleDescriptor(
            id = id,
            targetPackage = targetPackage,
            probeClasses = setOf(probeClass),
            classification = classification,
            install = install,
        )
    }

    override fun instantiateApplication(cl: ClassLoader, className: String): Application {
        Log.w(TAG, "HookComponentFactory.instantiateApplication()")
        Log.w(TAG, "  className=$className")
        Log.w(TAG, "  classLoader=$cl")
        val packageName = currentPackageName()
        val processName = Application.getProcessName()
        Log.w(TAG, "  package=${packageName ?: "unknown"}")
        Log.w(TAG, "  process=$processName pid=${android.os.Process.myPid()}")

        try {
            if (packageName == null) {
                Log.e(TAG, "Runtime package identity unavailable; skipping all hook modules")
            } else if (HOOK_MODULES.none { it.targetPackage == packageName }) {
                Log.w(TAG, "No registered hook module targets package $packageName")
            } else if (loadNativeLibs(cl)) {
                installMatchingModules(cl, packageName)
            } else {
                Log.e(TAG, "Required native hooks unavailable; skipping all hook modules")
            }
        } catch (t: Throwable) {
            Log.e(TAG, "Hook init failed, continuing without hooks", t)
        }

        return createApplication(cl, className)
    }

    /**
     * Probe the target classloader and install every matching hook module.
     */
    private fun installMatchingModules(cl: ClassLoader, packageName: String) {
        var installed = 0
        val packageModules = HOOK_MODULES.filter { it.targetPackage == packageName }
        Log.w(TAG, "Checking ${packageModules.size} hook modules for package $packageName")
        for (module in packageModules) {
            val matched = module.matches(packageName) { probeClass ->
                Log.w(TAG, "  Checking ${module.id} probe: $probeClass")
                try {
                    cl.loadClass(probeClass)
                    true
                } catch (_: ClassNotFoundException) {
                    false
                }
            }
            if (!matched) {
                Log.w(TAG, "  Module ${module.id} firmware probe did not match")
                continue
            }
            Log.w(TAG, "  Module matched: ${module.id} (${module.classification})")
            try {
                module.install(cl)
                installed++
            } catch (t: Throwable) {
                Log.e(TAG, "  Module install failed for ${module.id}", t)
            }
        }
        if (installed == 0) {
            Log.w(TAG, "  No hook modules matched this process")
        } else {
            Log.w(TAG, "  $installed hook module(s) installed")
        }
    }

    private fun currentPackageName(): String? = runCatching {
        val activityThread = Class.forName("android.app.ActivityThread")
        activityThread.getDeclaredMethod("currentPackageName").invoke(null) as? String
    }.getOrNull()?.takeIf(String::isNotBlank)

    /**
     * Load native libraries by absolute path.
     *
     * We're running inside the target process, so System.loadLibrary() would search
     * the target's nativeLibraryDir, not ours. We find our own APK's extracted lib
     * directory and load explicitly.
     *
     * Load order:
     * 1. AliuHook libs (libc++_shared, liblsplant, libaliuhook) — in dependency order
     * 2. Optional Frida Gadget, if packaged with -PincludeFrida=true. It starts a
     *    listen server on port 27042 for interactive exploration. Config file
     *    (libfrida-gadget.config.so) must be extracted alongside it; it sets
     *    on_load=resume so ironman is not blocked at startup.
     */
    private fun loadNativeLibs(cl: ClassLoader): Boolean {
        val libDir = findHookNativeLibDir(cl)
        if (libDir == null) {
            Log.e(TAG, "Could not find hook APK native lib directory")
            return false
        }

        Log.w(TAG, "Loading native libs from: $libDir")

        if (!HookNativeLibraryLocator.containsRequiredLibraries(libDir)) {
            Log.e(TAG, "Hook APK native lib directory is incomplete")
            return false
        }

        // AliuHook native libs — preflighted above, then loaded in dependency order.
        for (libName in HookNativeLibraryLocator.REQUIRED_NATIVE_LIBRARIES) {
            val libFile = File(libDir, libName)
            System.load(libFile.absolutePath)
            Log.w(TAG, "  Loaded $libName")
        }

        // Optional Frida Gadget — only packaged when built with -PincludeFrida=true.
        // Loaded AFTER AliuHook so method hooks are already installed. On load,
        // Gadget reads libfrida-gadget.config.so from the same directory and starts
        // a listen server (127.0.0.1:27042, on_load=resume).
        val fridaLib = File(libDir, "libfrida-gadget.so")
        if (fridaLib.exists()) {
            try {
                System.load(fridaLib.absolutePath)
                Log.w(TAG, "  Loaded libfrida-gadget.so — Frida listen server starting on :27042")
            } catch (t: Throwable) {
                Log.e(TAG, "  Failed to load Frida Gadget (non-fatal, continuing)", t)
            }
        } else {
            Log.w(TAG, "  libfrida-gadget.so not found in $libDir (Frida disabled)")
        }
        return true
    }

    /**
     * Locate our APK's extracted native library directory.
     *
     * The injected PathClassLoader exposes the hook APK's unique AliuHook entry
     * as a `jar:file:...!/lib/arm64-v8a/libaliuhook.so` resource. Resolve that
     * first so normal randomized Android package paths keep working. The legacy
     * fixed injector path remains a fallback for older installations.
     */
    private fun findHookNativeLibDir(cl: ClassLoader): File? {
        try {
            val resources = cl.getResources(HookNativeLibraryLocator.NATIVE_RESOURCE)
            while (resources.hasMoreElements()) {
                val apk = HookNativeLibraryLocator.hookApkFromNativeResource(
                    resources.nextElement(),
                ) ?: continue
                if (!apk.isFile) continue
                val found = findLibSubdir(apk.parentFile ?: continue)
                if (found != null) return found
            }
        } catch (error: Throwable) {
            Log.w(TAG, "Could not resolve hook native resource: ${error.message}")
        }

        // Legacy fixed path from the original injector implementation. Do not
        // recursively scan /data/app: that can mix an active hook DEX with a
        // stale package version's native libraries during an update.
        val injectedDir = File("/data/app", "$HOOK_PACKAGE-injected")
        if (injectedDir.isDirectory) {
            val found = findLibSubdir(injectedDir)
            if (found != null) return found
        }
        return null
    }

    private fun findLibSubdir(appDir: File): File? {
        for (subdir in listOf("lib/arm64", "lib/arm64-v8a")) {
            val candidate = File(appDir, subdir)
            if (
                candidate.isDirectory &&
                HookNativeLibraryLocator.containsRequiredLibraries(candidate)
            ) {
                return candidate
            }
        }
        return null
    }

    /**
     * Instantiate the Application class directly.
     *
     * The original appComponentFactory (androidx.core.app.CoreComponentFactory) just
     * does the same thing — calls cl.loadClass(className).newInstance(). No need to
     * delegate through it.
     */
    private fun createApplication(cl: ClassLoader, className: String): Application {
        Log.w(TAG, "Instantiating $className")
        return cl.loadClass(className).getDeclaredConstructor().newInstance() as Application
    }
}
