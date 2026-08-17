package com.penumbraos.server

import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DatabaseStorageTest {

    @Test
    fun migrationCopiesDatabaseWalAndIrohIdentityBeforeCompleting() {
        val root = Files.createTempDirectory("penumbra-db-migration").toFile()
        val legacyDir = root.resolve("legacy").apply { mkdirs() }
        val privateDir = root.resolve("private").apply { mkdirs() }
        val legacy = legacyDir.resolve("penumbra.db").apply { writeText("database") }
        legacyDir.resolve("penumbra.db-wal").writeText("wal-data")
        legacyDir.resolve("iroh_secret.key").writeText("identity")
        val target = privateDir.resolve("penumbra.db")
        var validations = 0
        try {
            assertTrue(
                DatabaseStorage.migrateLegacyDatabase(legacy, target) { database ->
                    validations++
                    assertEquals("database", database.readText())
                    assertEquals("wal-data", privateDir.resolve("penumbra.db-wal").readText())
                    assertEquals("identity", privateDir.resolve("iroh_secret.key").readText())
                },
            )
            assertTrue(DatabaseStorage.migrationIsComplete(target))

            assertFalse(
                DatabaseStorage.migrateLegacyDatabase(legacy, target) { database ->
                    validations++
                    assertEquals("database", database.readText())
                },
            )
            assertEquals(1, validations)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun pendingMigrationDiscardsPartialTargetAndRestartsFromLegacy() {
        val root = Files.createTempDirectory("penumbra-db-retry").toFile()
        val legacyDir = root.resolve("legacy").apply { mkdirs() }
        val privateDir = root.resolve("private").apply { mkdirs() }
        val legacy = legacyDir.resolve("penumbra.db").apply { writeText("complete-database") }
        legacyDir.resolve("penumbra.db-wal").writeText("complete-wal")
        val target = privateDir.resolve("penumbra.db").apply { writeText("partial") }
        DatabaseStorage.migrationStateFile(target).writeText("version=2\nstate=pending\n")
        try {
            assertTrue(
                DatabaseStorage.migrateLegacyDatabase(legacy, target) { database ->
                    assertEquals("complete-database", database.readText())
                    assertEquals("complete-wal", privateDir.resolve("penumbra.db-wal").readText())
                },
            )
            assertTrue(DatabaseStorage.migrationIsComplete(target))
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun retirementRemovesOnlyTheKnownLegacyArtifacts() {
        val root = Files.createTempDirectory("penumbra-db-retire").toFile()
        val legacy = root.resolve("penumbra.db").apply { writeText("database") }
        root.resolve("penumbra.db-wal").writeText("wal")
        root.resolve("penumbra.db-shm").writeText("shm")
        root.resolve("iroh_secret.key").writeText("identity")
        val unrelated = root.resolve("media.jpg").apply { writeText("keep") }
        try {
            DatabaseStorage.retireLegacyDatabase(legacy)
            assertFalse(legacy.exists())
            assertFalse(root.resolve("penumbra.db-wal").exists())
            assertFalse(root.resolve("penumbra.db-shm").exists())
            assertFalse(root.resolve("iroh_secret.key").exists())
            assertTrue(unrelated.exists())
        } finally {
            root.deleteRecursively()
        }
    }
}
