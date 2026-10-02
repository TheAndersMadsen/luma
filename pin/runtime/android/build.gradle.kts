import org.gradle.api.tasks.Exec
import org.gradle.api.tasks.Sync
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The S6 architecture move renamed this Gradle project from `server` to
// `:runtime:android`, which would rename its APK output to `host-release.apk`.
// The shipped artifact is still the Server (package `com.penumbraos.server`).
// Pin the archive base name so canonical toolchain consumers keep the stable
// `server-{variant}.apk` filename across the directory move.
base {
    archivesName.set("server")
}

val tierAManifestPlaceholdersFile =
    rootProject.file("contracts/tier-a/manifest-placeholders.properties")
if (!tierAManifestPlaceholdersFile.isFile) {
    throw GradleException(
        "Generated Tier-A manifest placeholders are missing. " +
            "Run the internal Tier-A generator through the root `./luma` command.",
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

val rustAbi = "arm64-v8a"
val rustTarget = "aarch64-linux-android"
val rustExecutableName = "humane-server"
val packagedRustLibraryName = "libpenumbra_server_android.so"
val rustProjectDir = rootProject.layout.projectDirectory.dir("runtime/core")
val rustTargetBinary = rustProjectDir.file("target/$rustTarget/release/$rustExecutableName")

val generatedJniLibsDir = layout.buildDirectory.dir("generated/jniLibs/main")

val configuredVersionCode = providers.gradleProperty("versionCode").orNull
    ?.trim()
    ?.toIntOrNull()
val configuredVersionName = providers.gradleProperty("versionName").orNull
    ?.trim()
    ?.takeIf(String::isNotEmpty)
val androidVersionName = configuredVersionName ?: "1.0"
val lumaCompileOnlyDebug = providers.gradleProperty("lumaCompileOnlyDebug")
    .map { it == "true" }
    .getOrElse(false)

val buildRustServerAndroid by tasks.registering(Exec::class) {
    group = "build"
    description = "Builds the Rust server for Android arm64."
    workingDir = rustProjectDir.asFile
    // API 24 introduced getifaddrs/freeifaddrs. The Pin is API 32. Building
    // against cargo-ndk's API-21 default makes librespot's pure-Rust mDNS
    // backend fail at link time even though the symbols exist on-device.
    commandLine(
        "cargo", "ndk", "-P", "31", "-t", rustAbi,
        // `iroh` bakes in the remote-Center P2P tunnel (off by default at
        // runtime via `server.iroh_remote_center_enabled`). It powers the
        // VPS bridge behind https://aipin.example.com.
        "build", "--release", "--features", "iroh",
    )
    environment("PENUMBRA_VERSION", androidVersionName)

    inputs.property("penumbraVersion", androidVersionName)
    inputs.files(
        fileTree(rustProjectDir.asFile) {
            exclude("target/**")
        }
    )
    outputs.file(rustTargetBinary)
}

val stageRustServerJniLibs by tasks.registering(Sync::class) {
    group = "build"
    description = "Stages the Rust server executable as a JNI lib."
    dependsOn(buildRustServerAndroid)

    into(generatedJniLibsDir)
    from(rustTargetBinary) {
        into(rustAbi)
        rename { packagedRustLibraryName }
    }
}

android {
    sourceSets {
        getByName("main") {
            jniLibs.setSrcDirs(listOf(generatedJniLibsDir))
        }
    }

    namespace = "com.penumbraos.server"
    compileSdk = 34

    buildFeatures {
        buildConfig = true
    }

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
        applicationId = "com.penumbraos.server"
        minSdk = 31
        targetSdk = 32
        versionCode = configuredVersionCode ?: 1
        versionName = androidVersionName
        manifestPlaceholders.putAll(tierAManifestPlaceholders)

        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
            keepDebugSymbols += "**/libpenumbra_server_android.so"
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
        check(!lumaCompileOnlyDebug) {
            "Compile-only debug mode can never enter Pin release packaging."
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

tasks.named("preBuild") {
    if (!lumaCompileOnlyDebug) {
        dependsOn(stageRustServerJniLibs)
    }
}

dependencies {
    implementation(project(":contracts:stock-aibus"))
    implementation(project(":contracts:penumbra-ipc"))
    implementation("org.jmdns:jmdns:3.6.3")
    testImplementation("junit:junit:4.13.2")
    // Android's unit-test stub throws for org.json methods. Use the real JVM
    // implementation so the bounded loopback protocol is exercised off-device.
    testImplementation("org.json:json:20240303")
}
