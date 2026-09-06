plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The shared Rust client is compiled by ./revival client build android and
// handed in from the external build directory together with the LiveKit
// libwebrtc.jar the native library binds to. Nothing is generated in-tree.
val cosmosJniLibs = providers.gradleProperty("cosmosJniLibs").orNull
    ?: throw GradleException("Pass -PcosmosJniLibs=<directory containing arm64-v8a/libcosmos_surface_client_ffi.so>")
val cosmosWebrtcJar = providers.gradleProperty("cosmosWebrtcJar").orNull
    ?: throw GradleException("Pass -PcosmosWebrtcJar=<verified libwebrtc.jar>")

android {
    namespace = "dk.andersmadsen.cosmos.android"
    compileSdk = 35
    defaultConfig {
        applicationId = "dk.andersmadsen.cosmos.android"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "0.2.0"
        ndk { abiFilters += listOf("arm64-v8a") }
    }
    sourceSets["main"].jniLibs.srcDirs(cosmosJniLibs)
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging { jniLibs.useLegacyPackaging = false }
    buildTypes {
        debug { isMinifyEnabled = false }
    }
}

dependencies {
    implementation(files(cosmosWebrtcJar))
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.animation:animation-core")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
