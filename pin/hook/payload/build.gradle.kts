import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val tierAManifestPlaceholdersFile =
    rootProject.file("contracts/tier-a/manifest-placeholders.properties")
if (!tierAManifestPlaceholdersFile.isFile) {
    throw GradleException(
        "Generated Tier-A manifest placeholders are missing. " +
            "Run the internal Tier-A generator through the root `./revival` command.",
    )
}
val tierAManifestPlaceholders = Properties().apply {
    tierAManifestPlaceholdersFile.inputStream().use { load(it) }
}.entries.associate { (key, value) ->
    key.toString() to value.toString()
}

fun secretProperty(propertyName: String, environmentName: String): String? =
    providers.gradleProperty(propertyName)
        .orElse(providers.environmentVariable(environmentName))
        .orNull
        ?.takeIf(String::isNotBlank)

val pinSigningStorePath = secretProperty("pinSigningStoreFile", "PIN_SIGNING_STORE_FILE")
val pinSigningStorePassword = secretProperty("pinSigningStorePassword", "PIN_SIGNING_STORE_PASSWORD")
val pinSigningKeyAlias = secretProperty("pinSigningKeyAlias", "PIN_SIGNING_KEY_ALIAS")
val pinSigningKeyPassword = secretProperty("pinSigningKeyPassword", "PIN_SIGNING_KEY_PASSWORD")
val pinSigningValues = listOf(
    pinSigningStorePath,
    pinSigningStorePassword,
    pinSigningKeyAlias,
    pinSigningKeyPassword,
)
val hasCompletePinSigning = pinSigningValues.all { it != null }
val hasPartialPinSigning = pinSigningValues.any { it != null } && !hasCompletePinSigning

if (hasPartialPinSigning) {
    throw GradleException(
        "Pin signing is incomplete. Supply all four external pinSigning* properties " +
            "or PIN_SIGNING_* environment variables; no signing value has an in-repository default.",
    )
}

val includeFrida = providers.gradleProperty("includeFrida")
    .map { it.equals("true", ignoreCase = true) || it == "1" }
    .getOrElse(false)
val configuredVersionCode = providers.gradleProperty("versionCode").orNull
    ?.trim()
    ?.toIntOrNull()
val configuredVersionName = providers.gradleProperty("versionName").orNull
    ?.trim()
    ?.takeIf(String::isNotEmpty)

android {
    namespace = "com.penumbraos.hook"
    compileSdk = 34

    signingConfigs {
        if (hasCompletePinSigning) {
            create("externalCompatibility") {
                val configuredStore = rootProject.file(checkNotNull(pinSigningStorePath))
                if (!configuredStore.isFile) {
                    throw GradleException("Pin signing keystore does not exist or is not a regular file.")
                }
                storeFile = configuredStore
                storePassword = checkNotNull(pinSigningStorePassword)
                keyAlias = checkNotNull(pinSigningKeyAlias)
                keyPassword = checkNotNull(pinSigningKeyPassword)
            }
        }
    }

    defaultConfig {
        applicationId = "com.penumbraos.hook"
        minSdk = 31
        targetSdk = 32
        versionCode = configuredVersionCode ?: 1
        versionName = configuredVersionName ?: "1.0"
        manifestPlaceholders.putAll(tierAManifestPlaceholders)

        // Only arm64 — the Humane AI Pin is arm64-v8a only
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    sourceSets {
        getByName("main") {
            if (includeFrida) {
                jniLibs.srcDir("frida")
            }
        }
    }

    packaging {
        jniLibs {
            // Native libs MUST be extracted to disk so we can System.load() by absolute path
            // from inside the target process (ironman).
            useLegacyPackaging = true

            if (includeFrida) {
                // Prevent AGP from stripping Frida Gadget files:
                // - libfrida-gadget.so must not be stripped (breaks the binary)
                // - libfrida-gadget.config.so is a JSON config file disguised as .so —
                //   strip would corrupt/fail on it
                keepDebugSymbols += "**/libfrida-gadget.so"
                keepDebugSymbols += "**/libfrida-gadget.config.so"
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfigs.findByName("externalCompatibility")?.let { signingConfig = it }
        }
        getByName("debug") {
            signingConfigs.findByName("externalCompatibility")?.let { signingConfig = it }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    kotlinOptions {
        jvmTarget = "11"
    }

    lint {
        disable += "ExpiredTargetSdkVersion"
    }
}

val pinReleasePackagingTasks = setOf(
    "assembleRelease",
    "bundleRelease",
    "installRelease",
    "packageRelease",
    "packageReleaseBundle",
    "packageReleaseUniversalApk",
    "signReleaseBundle",
    "makeApkFromBundleForRelease",
    "extractApksForRelease",
    "extractApksFromBundleForRelease",
    "zipApksForRelease",
)

gradle.taskGraph.whenReady {
    val packagesPinRelease = allTasks.any { task ->
        task.project == project && task.name in pinReleasePackagingTasks
    }
    if (packagesPinRelease) {
        check(!includeFrida) {
            "Refusing to package a Pin release with Frida Gadget enabled."
        }
        check(hasCompletePinSigning) {
            "Refusing to package a Pin release without all four external signing inputs."
        }
        check(configuredVersionCode != null && configuredVersionCode > 1) {
            "Release builds require an explicit positive -PversionCode greater than 1."
        }
        check(configuredVersionName != null && configuredVersionName != "1.0") {
            "Release builds require an explicit non-default -PversionName."
        }
    }
}

dependencies {
    implementation(project(":contracts:stock-aibus"))
    implementation(project(":contracts:penumbra-ipc"))
    implementation("com.aliucord:Aliuhook:1.1.4")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
