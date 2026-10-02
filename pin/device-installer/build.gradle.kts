plugins {
    id("com.android.application") version "8.7.3" apply false
    id("com.android.library") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.1.0" apply false
}

// Pin every Android module to the exact build-tools the release container
// installs, so AGP's lintVital does not fall back to a default revision the
// pinned single-toolchain image does not contain. The image exports the
// installed version as LUMA_ANDROID_BUILD_TOOLS_VERSION.
subprojects {
    val pinnedBuildTools = System.getenv("LUMA_ANDROID_BUILD_TOOLS_VERSION")?.trim()
    if (!pinnedBuildTools.isNullOrEmpty()) {
        plugins.withId("com.android.application") {
            extensions.configure<com.android.build.api.dsl.ApplicationExtension> {
                buildToolsVersion = pinnedBuildTools
            }
        }
        plugins.withId("com.android.library") {
            extensions.configure<com.android.build.api.dsl.LibraryExtension> {
                buildToolsVersion = pinnedBuildTools
            }
        }
    }
}
