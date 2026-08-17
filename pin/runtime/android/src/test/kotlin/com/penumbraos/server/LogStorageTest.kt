package com.penumbraos.server

import java.nio.file.Files
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LogStorageTest {

    @Test
    fun retirementRemovesManagedLogsAndPreservesUnknownFiles() {
        val directory = Files.createTempDirectory("penumbra-log-retire").toFile()
        directory.resolve("humane-server.2026-07-24").writeText("server log")
        directory.resolve("llm-requests.2026-07-24.jsonl").writeText("sensitive request")
        val unrelated = directory.resolve("operator-notes.txt").apply { writeText("keep") }
        try {
            LogStorage.retireLegacyLogs(directory)
            assertFalse(directory.resolve("humane-server.2026-07-24").exists())
            assertFalse(directory.resolve("llm-requests.2026-07-24.jsonl").exists())
            assertTrue(unrelated.exists())
            assertTrue(directory.exists())
        } finally {
            directory.deleteRecursively()
        }
    }
}
