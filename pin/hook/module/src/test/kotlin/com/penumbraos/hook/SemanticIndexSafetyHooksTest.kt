package com.penumbraos.hook

import com.penumbraos.stockaibus.contract.StockSymbols
import java.io.File
import java.util.zip.ZipFile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Host contract for the fixed-width native semantic-index boundary. */
class SemanticIndexSafetyHooksTest {
    @Test
    fun `only exact finite 512 dimensional embeddings may reach native`() {
        assertTrue(
            SemanticIndexSafetyHooks.isSafeNativeEmbedding(
                FloatArray(SemanticIndexSafetyHooks.EMBEDDING_DIMENSIONS) { index ->
                    (index - 256) / 512.0f
                },
            ),
        )

        assertFalse(SemanticIndexSafetyHooks.isSafeNativeEmbedding(null))
        assertFalse(SemanticIndexSafetyHooks.isSafeNativeEmbedding("not an embedding"))
        assertFalse(SemanticIndexSafetyHooks.isSafeNativeEmbedding(FloatArray(511)))
        assertFalse(SemanticIndexSafetyHooks.isSafeNativeEmbedding(FloatArray(513)))

        listOf(Float.NaN, Float.POSITIVE_INFINITY, Float.NEGATIVE_INFINITY).forEach { invalid ->
            val embedding = FloatArray(512)
            embedding[271] = invalid
            assertFalse(SemanticIndexSafetyHooks.isSafeNativeEmbedding(embedding))
        }
    }

    @Test
    fun `hook is bound to the exact messages overload and pinned native evidence`() {
        val root = repositoryRoot()
        val messagesApk = StockReference.requireReviewedApk(
            "humane_messages.apk",
            "17795dc680d30c5c48001d49d06c3d99e7b1bc5d8c419435aa050e91715727b3",
        )
        StockReference.requireReviewedApk(
            "ironman.apk",
            "5d60b33eacdc53a35ea8476d36e05f29f6fab22440ef777e44b5d4269e277232",
        )
        val stockApi = StockReference.decompiled(
            "humane_messages/sources/humane/experience/messages/utilities/SemanticIndex.java",
            "9c8246e72ff10609ae6d70ce58d8806266305b7f88242b81b1992fc054481381",
        ).readText()
        val nativeReference = StockReference.decompiled(
            "ironman/resources/lib/arm64-v8a/libsemantic_index.so",
            "c990eb789959b2d86f0dc86ddf47636cd4701b2bdbb5c4286bce08b4b9cda0fa",
        )
        ZipFile(messagesApk).use { apk ->
            val nativeEntry = apk.getEntry("lib/arm64-v8a/libsemantic_index.so")
                ?: throw AssertionError("Messages APK is missing libsemantic_index.so")
            apk.getInputStream(nativeEntry).use { input ->
                assertEquals(
                    "Messages must retain the Ghidra-reviewed semantic-index binary",
                    StockReference.sha256(nativeReference),
                    StockReference.sha256(input),
                )
            }
        }

        assertTrue(stockApi.contains("public void insert(float[] embedding, long label)"))
        assertTrue(
            stockApi.contains(
                "insertFromEmbeddingNative(this.mNativePtr, embedding, label);",
            ),
        )

        val hook = File(
            root,
            "hook/module/src/main/kotlin/com/penumbraos/hook/SemanticIndexSafetyHooks.kt",
        ).readText()
        assertTrue(hook.contains("arrayOf(FloatArray::class.java, Long::class.javaPrimitiveType!!)"))
        assertTrue(hook.contains("param.result = null"))
        assertFalse(hook.contains("insertFromTextNative"))

        val factory = File(
            root,
            "hook/module/src/main/kotlin/com/penumbraos/hook/HookComponentFactory.kt",
        ).readText()
        // Registration is a structured module(id, package, class, classification,
        // installer) entry. Match the whole block so the target class stays bound
        // to this installer, rather than matching a formatting detail.
        assertTrue(
            Regex(
                """module\(\s*"[^"]*",\s*StockSymbols\.Messages\.PACKAGE,\s*""" +
                    """StockSymbols\.Messages\.SEMANTIC_INDEX_CLASS,\s*""" +
                    """HookClassification\.\w+,\s*SemanticIndexSafetyHooks::install,""",
            ).containsMatchIn(factory),
        )
        // The registration now names shared constants. Pin the values here too
        // so this guard still fails if the target package or class ever moves.
        assertEquals("humane.experience.messages", StockSymbols.Messages.PACKAGE)
        assertEquals(
            "humane.experience.messages.utilities.SemanticIndex",
            StockSymbols.Messages.SEMANTIC_INDEX_CLASS,
        )
        assertTrue(hook.contains("StockSymbols.Messages.SEMANTIC_INDEX_CLASS"))
    }

    private fun repositoryRoot(): File {
        val candidates = listOf(File("."), File(".."), File("../.."))
        return candidates.firstOrNull {
            File(it, "hook/module/src/main/kotlin/com/penumbraos/hook").isDirectory
        } ?: throw AssertionError("Missing repository Hook source directory")
    }
}
