package com.penumbraos.hook

import java.net.URL
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class HookNativeLibraryLocatorTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `resolves randomized Android package path`() {
        val resource = URL(
            "jar:file:/data/app/~~installer-token/" +
                "com.penumbraos.hook-package-token/base.apk!/" +
                HookNativeLibraryLocator.NATIVE_RESOURCE,
        )

        assertEquals(
            "/data/app/~~installer-token/com.penumbraos.hook-package-token/base.apk",
            HookNativeLibraryLocator.hookApkFromNativeResource(resource)?.path,
        )
    }

    @Test
    fun `resolves legacy injector path`() {
        val resource = URL(
            "jar:file:/data/app/com.penumbraos.hook-injected/base.apk!/" +
                HookNativeLibraryLocator.NATIVE_RESOURCE,
        )

        assertEquals(
            "/data/app/com.penumbraos.hook-injected/base.apk",
            HookNativeLibraryLocator.hookApkFromNativeResource(resource)?.path,
        )
    }

    @Test
    fun `resolves file URI with an empty authority`() {
        val resource = URL(
            "jar:file:///data/app/~~installer-token/" +
                "com.penumbraos.hook-package-token/base.apk!/" +
                HookNativeLibraryLocator.NATIVE_RESOURCE,
        )

        assertEquals(
            "/data/app/~~installer-token/com.penumbraos.hook-package-token/base.apk",
            HookNativeLibraryLocator.hookApkFromNativeResource(resource)?.path,
        )
    }

    @Test
    fun `rejects another package resource`() {
        val resource = URL(
            "jar:file:/data/app/~~installer-token/humane.experience.music-token/base.apk!/" +
                HookNativeLibraryLocator.NATIVE_RESOURCE,
        )

        assertNull(HookNativeLibraryLocator.hookApkFromNativeResource(resource))
    }

    @Test
    fun `rejects a different native entry`() {
        val resource = URL(
            "jar:file:/data/app/~~installer-token/" +
                "com.penumbraos.hook-package-token/base.apk!/lib/arm64-v8a/libother.so",
        )

        assertNull(HookNativeLibraryLocator.hookApkFromNativeResource(resource))
    }

    @Test
    fun `rejects traversal outside data app`() {
        val resource = URL(
            "jar:file:/data/app/../system/com.penumbraos.hook-package-token/base.apk!/" +
                HookNativeLibraryLocator.NATIVE_RESOURCE,
        )

        assertNull(HookNativeLibraryLocator.hookApkFromNativeResource(resource))
    }

    @Test
    fun `rejects a non jar URL`() {
        val resource = URL("file:/data/app/com.penumbraos.hook-injected/base.apk")

        assertNull(HookNativeLibraryLocator.hookApkFromNativeResource(resource))
    }

    @Test
    fun `requires the complete native dependency set`() {
        val directory = temporaryFolder.newFolder("native")
        assertFalse(HookNativeLibraryLocator.containsRequiredLibraries(directory))

        HookNativeLibraryLocator.REQUIRED_NATIVE_LIBRARIES.forEach { name ->
            assertTrue(java.io.File(directory, name).createNewFile())
        }

        assertTrue(HookNativeLibraryLocator.containsRequiredLibraries(directory))
    }
}
