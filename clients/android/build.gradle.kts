// Same plugin generation as the Pin build so the pinned Gradle 8.9 wrapper and
// cached artifacts serve both; Compose comes from the matching Kotlin release.
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.1.0" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.1.0" apply false
}

// Build output stays outside the source checkout. The CLI passes the root;
// a bare Gradle invocation refuses rather than writing into the tree.
val cosmosBuildRoot = providers.gradleProperty("cosmosBuildDir").orNull
    ?: throw GradleException("Pass -PcosmosBuildDir=<external directory>; use ./revival client build android")
allprojects {
    layout.buildDirectory.set(File(cosmosBuildRoot, project.path.replace(':', '_').ifEmpty { "root" }))
}
