import java.util.Properties
import java.security.MessageDigest

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
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

        // Only arm64, the Humane AI Pin is arm64-v8a only
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    packaging {
        jniLibs {
            // Native libs MUST be extracted to disk so we can System.load() by absolute path
            // from inside the target process (ironman).
            useLegacyPackaging = true
            keepDebugSymbols += "**/libghostlock_aipin.so"
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

val ghostlockVendorRoot = rootProject.file("ghostlock")
val stagedGhostlockRoot = layout.buildDirectory.dir("generated/standaloneDock/vendor")
val stagedGhostlockSource = stagedGhostlockRoot.map { it.dir("source") }
val generatedGhostlockJni = layout.buildDirectory.dir("generated/standaloneDock/jniLibs")
val generatedGhostlockAssets = layout.buildDirectory.dir("generated/standaloneDock/assets")

val stageStandaloneDockSource by tasks.registering(Sync::class) {
    from(ghostlockVendorRoot) {
        include("ghostlock_profile.py")
        include("profiles/**")
        include("scripts/generate_profile_header.py")
        include("source/**")
        exclude("source/build/**")
    }
    into(stagedGhostlockRoot)
}

val buildStandaloneDockPayload by tasks.registering(Exec::class) {
    dependsOn(stageStandaloneDockSource)
    val sourceDir = stagedGhostlockSource.get().asFile
    workingDir(sourceDir)
    inputs.dir(sourceDir)
    outputs.file(sourceDir.resolve("build/humane-aipin-45.20/bin/preload.so"))
    doFirst {
        val ndkRoot = providers.environmentVariable("ANDROID_NDK_HOME")
            .orElse(providers.environmentVariable("ANDROID_NDK_ROOT"))
            .orNull
            ?.let(::file)
            ?: throw GradleException(
                "Standalone dock payload requires pinned Android NDK 28.2.13676358.",
            )
        val sourceProperties = ndkRoot.resolve("source.properties")
        if (
            !sourceProperties.isFile ||
            !sourceProperties.readText().lineSequence().any {
                it.trim() == "Pkg.Revision = 28.2.13676358"
            }
        ) {
            throw GradleException(
                "Standalone dock payload requires exact Android NDK 28.2.13676358.",
            )
        }
        environment("NDK_ROOT", ndkRoot.absolutePath)
    }
    commandLine("make", "PROJECT=humane-aipin-45.20", "preload")
}

val prepareStandaloneDockPayload by tasks.registering {
    dependsOn(buildStandaloneDockPayload)
    val nativeOutput = generatedGhostlockJni.map {
        it.file("arm64-v8a/libghostlock_aipin.so")
    }
    val assetsOutput = generatedGhostlockAssets.map { it.dir("ghostlock") }
    inputs.file(stagedGhostlockSource.map {
        it.file("build/humane-aipin-45.20/bin/preload.so")
    })
    inputs.file(ghostlockVendorRoot.resolve("profiles/humane-45.20/profile.json"))
    inputs.file(ghostlockVendorRoot.resolve("profiles/humane-45.20/symbols.txt"))
    outputs.file(nativeOutput)
    outputs.dir(assetsOutput)
    doLast {
        val payload = stagedGhostlockSource.get().asFile
            .resolve("build/humane-aipin-45.20/bin/preload.so")
        val nativeFile = nativeOutput.get().asFile
        nativeFile.parentFile.mkdirs()
        payload.copyTo(nativeFile, overwrite = true)

        val assetsDir = assetsOutput.get().asFile
        assetsDir.mkdirs()
        ghostlockVendorRoot.resolve("profiles/humane-45.20/profile.json")
            .copyTo(assetsDir.resolve("profile.json"), overwrite = true)
        ghostlockVendorRoot.resolve("profiles/humane-45.20/symbols.txt")
            .copyTo(assetsDir.resolve("symbols.txt"), overwrite = true)
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(nativeFile.readBytes())
            .joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
        assetsDir.resolve("payload.sha256").writeText("$digest\n")
    }
}

android.sourceSets.getByName("main").apply {
    jniLibs.srcDir(generatedGhostlockJni)
    assets.srcDir(generatedGhostlockAssets)
}

tasks.configureEach {
    if (
        (
            name.startsWith("merge") &&
                (name.endsWith("JniLibFolders") || name.endsWith("Assets"))
            ) ||
        name.contains("lint", ignoreCase = true)
    ) {
        dependsOn(prepareStandaloneDockPayload)
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
