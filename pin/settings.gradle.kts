pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        // Optional checksum-pinned offline mirror populated by
        // platform/containers/pin-builder/bootstrap-aliuhook.sh. The directory stays untracked.
        maven {
            url = uri(rootDir.resolve(".ci/m2"))
            content {
                includeGroup("com.aliucord")
                includeGroup("com.aliucord.lsplant")
            }
        }
        maven {
            url = uri("https://maven.aliucord.com/releases")
            content {
                includeGroup("com.aliucord")
                includeGroup("com.aliucord.lsplant")
            }
        }
        google()
        mavenCentral()
    }
}

rootProject.name = "ai-pin-revival-pin"
include(":hook:payload")
include(":hook:loader")
include(":runtime:android")
include(":contracts:stock-aibus")
include(":contracts:penumbra-ipc")
