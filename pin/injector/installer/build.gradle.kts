import java.io.File
import java.security.KeyStore
import java.security.PrivateKey
import java.security.cert.X509Certificate

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun secretProperty(propertyName: String, environmentName: String): String? =
    providers.gradleProperty(propertyName)
        .orElse(providers.environmentVariable(environmentName))
        .orNull
        ?.trim()
        ?.takeIf(String::isNotEmpty)

fun externalRegularFile(rawPath: String, label: String): File {
    val selected = File(rawPath)
    if (!selected.isAbsolute) throw GradleException("$label must be an absolute external path")
    val canonical = selected.canonicalFile
    if (canonical.toPath().startsWith(rootProject.projectDir.canonicalFile.toPath())) {
        throw GradleException("$label must live outside the Ai Pin Revival source tree")
    }
    if (!canonical.isFile) throw GradleException("$label is missing or is not a regular file")
    return canonical
}

val legacyDebugSigningStoreFile = providers.gradleProperty("legacyDebugSigningStoreFile")
    .orElse(providers.environmentVariable("REVIVAL_PIN_LEGACY_DEBUG_SIGNING_STORE_FILE"))
    .orNull
    ?.trim()
    ?.takeIf(String::isNotEmpty)
    ?.let { externalRegularFile(it, "Pin legacy debug signing store") }
val embeddedPatchSigningStoreFile = providers.gradleProperty("embeddedPatchSigningStoreFile")
    .orElse(providers.environmentVariable("REVIVAL_PIN_EMBEDDED_PATCH_SIGNING_STORE_FILE"))
    .orNull
    ?.trim()
    ?.takeIf(String::isNotEmpty)
    ?.let { externalRegularFile(it, "Pin embedded-patch signing store") }
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
        "Pin signing is incomplete. Supply all four external PIN_SIGNING_* values.",
    )
}

val configuredVersionCode = providers.gradleProperty("versionCode").orNull
    ?.trim()
    ?.toIntOrNull()
val configuredVersionName = providers.gradleProperty("versionName").orNull
    ?.trim()
    ?.takeIf(String::isNotEmpty)
val generatedBootstrapAssets = layout.buildDirectory.dir("generated/bootstrapAssets")
val stageBootstrapAsset by tasks.registering {
    // The installer uses this identity for every APK it patches after the
    // one-shot bootstrap. Release APK package identity is configured
    // independently through the four external PIN_SIGNING_* values. Extract
    // standard PKCS#8/X.509 material at build time instead of asking Android's
    // old PKCS#12 provider to open a modern PBES2/AES-protected store.
    embeddedPatchSigningStoreFile?.let { inputs.file(it) }
    outputs.dir(generatedBootstrapAssets)
    doLast {
        val storeFile = checkNotNull(embeddedPatchSigningStoreFile) {
            "Installer packaging requires an external embedded-patch signing store."
        }
        val password = "abxdroppedapk".toCharArray()
        val keyStore = KeyStore.getInstance("PKCS12")
        storeFile.inputStream().use { keyStore.load(it, password) }
        val privateKey = keyStore.getKey("abxdroppedapk", password) as? PrivateKey
            ?: throw GradleException("Embedded-patch signing store has no private key")
        val certificate = keyStore.getCertificate("abxdroppedapk") as? X509Certificate
            ?: throw GradleException("Embedded-patch signing store has no X.509 certificate")
        check(privateKey.algorithm == "RSA" && privateKey.format == "PKCS#8") {
            "Embedded-patch private key must be PKCS#8 RSA"
        }
        check(certificate.publicKey.algorithm == "RSA") {
            "Embedded-patch certificate must contain an RSA public key"
        }

        val outputDir = generatedBootstrapAssets.get().asFile
        project.delete(outputDir)
        outputDir.mkdirs()
        File(outputDir, "abxdroppedapk-private-key.pk8").writeBytes(privateKey.encoded)
        File(outputDir, "abxdroppedapk-certificate.der").writeBytes(certificate.encoded)
        password.fill('\u0000')
    }
}

android {
    namespace = "com.penumbraos.systeminjector"
    compileSdk = 34

    signingConfigs {
        legacyDebugSigningStoreFile?.let { legacyStore ->
            create("legacyDebug") {
                storeFile = legacyStore
                storePassword = "abxdroppedapk"
                keyAlias = "abxdroppedapk"
                keyPassword = "abxdroppedapk"
            }
        }
        if (hasCompletePinSigning) {
            create("externalCompatibility") {
                storeFile = externalRegularFile(
                    checkNotNull(pinSigningStorePath),
                    "Pin compatibility signing store",
                )
                storePassword = checkNotNull(pinSigningStorePassword)
                keyAlias = checkNotNull(pinSigningKeyAlias)
                keyPassword = checkNotNull(pinSigningKeyPassword)
            }
        }
    }

    defaultConfig {
        applicationId = "com.penumbraos.systeminjector"
        minSdk = 31
        targetSdk = 32
        versionCode = configuredVersionCode ?: 1
        versionName = configuredVersionName ?: "1.0"
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfigs.findByName("externalCompatibility")?.let { signingConfig = it }
        }
        getByName("debug") {
            signingConfigs.findByName("legacyDebug")?.let { signingConfig = it }
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

    sourceSets {
        getByName("main").assets.srcDir(generatedBootstrapAssets)
    }
}

tasks.named("preBuild") {
    dependsOn(stageBootstrapAsset)
}

val pinReleasePackagingTasks = setOf(
    "assembleRelease",
    "bundleRelease",
    "installRelease",
    "packageRelease",
)

gradle.taskGraph.whenReady {
    val packagesPinRelease = allTasks.any { task ->
        task.project == project && task.name in pinReleasePackagingTasks
    }
    if (packagesPinRelease) {
        check(hasCompletePinSigning) {
            "Refusing to package a Pin release without all four external PIN_SIGNING_* values."
        }
        check(embeddedPatchSigningStoreFile != null) {
            "Refusing to package a Pin release without the external embedded-patch signing store."
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
    implementation(project(":common"))
    // ManifestEditor for binary AndroidManifest.xml patching
    implementation("com.github.WindySha:ManifestEditor:2.0")
    // apksig for APK signing
    implementation("com.android.tools.build:apksig:8.7.3")
    testImplementation("junit:junit:4.13.2")
}
