import org.gradle.api.tasks.Exec
import org.gradle.api.tasks.Sync
import java.io.File
import java.security.MessageDigest
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

val rustAbi = "arm64-v8a"
val rustTarget = "aarch64-linux-android"
val rustExecutableName = "humane-server"
val packagedRustLibraryName = "libpenumbra_server_android.so"
val packagedCodexAppServerName = "libcodex_app_server.so"
val rustProjectDir = rootProject.layout.projectDirectory.dir("runtime/core")
val rustTargetBinary = rustProjectDir.file("target/$rustTarget/release/$rustExecutableName")

// Native/model inputs are operator-supplied and must live outside this source
// tree. A Gradle property or environment variable may select another external
// location; relative/in-tree paths fail closed during configuration.
val configuredPrivateAssetsDir =
    System.getenv("REVIVAL_PIN_PRIVATE_ASSETS_DIR")
        ?: "${System.getProperty("user.home")}/.config/ai-pin-revival/pin-assets"
val defaultPinPrivateAssetsDir = File(configuredPrivateAssetsDir).also {
    if (!it.isAbsolute) {
        throw GradleException("REVIVAL_PIN_PRIVATE_ASSETS_DIR must be an absolute external path")
    }
}.canonicalFile

fun externalPrivateAsset(propertyName: String, environmentName: String, relativeDefault: String): File {
    val configured = (project.findProperty(propertyName) as String?)
        ?.trim()
        ?.takeIf(String::isNotEmpty)
        ?: System.getenv(environmentName)?.trim()?.takeIf(String::isNotEmpty)
    val candidate = if (configured == null) {
        defaultPinPrivateAssetsDir.resolve(relativeDefault)
    } else {
        File(configured).also {
            if (!it.isAbsolute) {
                throw GradleException("$propertyName must be an absolute external path")
            }
        }
    }.canonicalFile
    val sourceRoot = rootProject.projectDir.canonicalFile.toPath()
    if (candidate.toPath().startsWith(sourceRoot)) {
        throw GradleException(
            "$propertyName must point outside the Ai Pin Revival source tree: ${candidate.absolutePath}",
        )
    }
    return candidate
}

val codexAppServerBinary = externalPrivateAsset(
    "codexAppServerBinary",
    "REVIVAL_CODEX_APP_SERVER_BINARY",
    "codex-0.144.3/codex-app-server-aarch64-unknown-linux-musl",
)
val codexAppServerSha256 = "3f364d7813feb8807ac0b38fb8e02654774da1f3dd93c399a695b9e24714afc1"
// Compatible TFLite C runtime for the local-NLU assists. Pinned the same way as
// the Codex binary; the SONAME must stay `libtensorflowlite_jni.so`
// so the packaged name matches what the Rust link step recorded.
val tfliteRuntimeBinary = externalPrivateAsset(
    "tfliteRuntimeBinary",
    "REVIVAL_TFLITE_RUNTIME_BINARY",
    "tflite-2.11.0/libtensorflowlite_jni.so",
)
val tfliteRuntimeSha256 = "8e2acc968c1a2c6b92a641fe016a2f75de0bfde87548cba9972bcc36905f57ea"
val packagedTfliteName = "libtensorflowlite_jni.so"
val generatedJniLibsDir = layout.buildDirectory.dir("generated/jniLibs/main")

val configuredVersionCode = providers.gradleProperty("versionCode").orNull
    ?.trim()
    ?.toIntOrNull()
val configuredVersionName = providers.gradleProperty("versionName").orNull
    ?.trim()
    ?.takeIf(String::isNotEmpty)
val androidVersionName = configuredVersionName ?: "1.0"
val revivalCompileOnlyDebug = providers.gradleProperty("revivalCompileOnlyDebug")
    .map { it == "true" }
    .getOrElse(false)

val buildRustServerAndroid by tasks.registering(Exec::class) {
    group = "build"
    description = "Builds the Rust server for Android arm64."
    workingDir = rustProjectDir.asFile
    // API 24 introduced getifaddrs/freeifaddrs. The Pin is API 32; building
    // against cargo-ndk's API-21 default makes librespot's pure-Rust mDNS
    // backend fail at link time even though the symbols exist on-device.
    commandLine(
        "cargo", "ndk", "-P", "31", "-t", rustAbi,
        // `iroh` bakes in the remote-Center P2P tunnel (off by default at
        // runtime via `server.iroh_remote_center_enabled`); it powers the
        // VPS bridge behind https://aipin.example.com.
        "build", "--release", "--features", "local-nlu,iroh",
    )
    // tflitec links the externally supplied, digest-pinned compatible runtime.
    environment(
        "TFLITEC_PREBUILT_PATH_AARCH64_LINUX_ANDROID",
        tfliteRuntimeBinary.absolutePath,
    )
    // Given a prebuilt runtime, tflitec still wants the matching C headers, and
    // without this it fetches them from GitHub at build time — which the release
    // container forbids, because it builds with no network at all. These are the
    // public Apache-2.0 headers from the crate's own pinned tag (build.rs TAG =
    // v2.9.1), vendored beside the module; the runtime binary itself stays an
    // external, operator-held input.
    environment(
        "TFLITEC_HEADER_DIR_AARCH64_LINUX_ANDROID",
        layout.projectDirectory.dir("tflitec-headers").asFile.absolutePath,
    )
    environment("PENUMBRA_VERSION", androidVersionName)
    // tokenizers/esaxx-rs and ort-sys can link the Android C++ runtime. This
    // Rust binary is launched as a standalone executable, so link libc++
    // statically instead of requiring libc++_shared.so to be packaged/loaded.
    environment("CXXSTDLIB", "c++_static")
    environment("ORT_CXX_STDLIB", "c++_static")
    environment("RUSTFLAGS", "-C link-arg=-lc++abi")
    // ort-sys' download-binaries feature is enabled transitively by memvid-core,
    // but Android ONNX Runtime binaries are provided by onnxruntime-android and
    // loaded dynamically. Setting ORT_LIB_LOCATION suppresses the unsupported
    // ort-sys Android download path when ort/load-dynamic is also enabled.
    environment("ORT_LIB_LOCATION", rustProjectDir.dir("target/unused-ort-lib-location").asFile.absolutePath)

    inputs.property("penumbraVersion", androidVersionName)
    inputs.property("cxxStdlib", "c++_static")
    inputs.property("ortCxxStdlib", "c++_static")
    inputs.property("rustflags", "-C link-arg=-lc++abi")
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
    from(codexAppServerBinary) {
        into(rustAbi)
        rename { packagedCodexAppServerName }
    }
    from(tfliteRuntimeBinary) {
        into(rustAbi)
        rename { packagedTfliteName }
    }

    inputs.file(codexAppServerBinary)
    doFirst {
        check(codexAppServerBinary.isFile) {
            "Codex app-server binary is missing: ${codexAppServerBinary.absolutePath}"
        }
        val digest = MessageDigest.getInstance("SHA-256")
        codexAppServerBinary.inputStream().buffered().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        val actual = digest.digest().joinToString("") { byte ->
            "%02x".format(byte.toInt() and 0xff)
        }
        check(actual == codexAppServerSha256) {
            "Codex app-server binary failed SHA-256 verification"
        }
        check(tfliteRuntimeBinary.isFile) {
            "Pinned TFLite runtime is missing: ${tfliteRuntimeBinary.absolutePath}"
        }
        val tfliteDigest = MessageDigest.getInstance("SHA-256")
        tfliteRuntimeBinary.inputStream().buffered().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                tfliteDigest.update(buffer, 0, read)
            }
        }
        val tfliteActual = tfliteDigest.digest().joinToString("") { byte ->
            "%02x".format(byte.toInt() and 0xff)
        }
        check(tfliteActual == tfliteRuntimeSha256) {
            "Pinned TFLite runtime failed SHA-256 verification"
        }
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
            keepDebugSymbols += "**/libcodex_app_server.so"
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
        check(!revivalCompileOnlyDebug) {
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
    if (!revivalCompileOnlyDebug) {
        dependsOn(stageRustServerJniLibs)
    }
}

dependencies {
    implementation(project(":contracts:stock-aibus"))
    implementation(project(":contracts:penumbra-ipc"))
    implementation("org.jmdns:jmdns:3.6.3")
    // Raw-byte stock AiBus bridge client. The Binder adapter owns stock parcel
    // compatibility; this client forwards the exact protobuf bytes to the local
    // authenticated Rust gRPC endpoint without importing stock Java classes.
    implementation("io.grpc:grpc-okhttp:1.69.1")
    implementation("io.grpc:grpc-stub:1.69.1")
    // ort 2.0.0-rc.10 is generated against ONNX Runtime 1.22 (API 22).
    // Newer runtimes can load today but are explicitly outside ort's ABI check.
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.22.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("io.grpc:grpc-inprocess:1.69.1")
    // Android's unit-test stub throws for org.json methods. Use the real JVM
    // implementation so the bounded loopback protocol is exercised off-device.
    testImplementation("org.json:json:20240303")
}
