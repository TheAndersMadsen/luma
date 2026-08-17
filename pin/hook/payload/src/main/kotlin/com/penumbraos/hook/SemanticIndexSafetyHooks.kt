package com.penumbraos.hook

import android.util.Log
import com.penumbraos.stockaibus.contract.StockSymbols

/**
 * Keeps malformed persisted message embeddings out of the stock native index.
 *
 * The pinned semantic_index binary consumes exactly 512 floats without reading
 * the Java array length. Valid stock vectors delegate unchanged; only vectors
 * that cannot satisfy that native contract are discarded.
 */
object SemanticIndexSafetyHooks {
    private const val TAG = "PenumbraHook"
    internal const val EMBEDDING_DIMENSIONS = 512

    fun install(classLoader: ClassLoader) {
        try {
            val semanticIndex = classLoader.loadClass(
                StockSymbols.Messages.SEMANTIC_INDEX_CLASS,
            )
            val installed = HookUtils.hookMethodBefore(
                semanticIndex,
                "insert",
                arrayOf(FloatArray::class.java, Long::class.javaPrimitiveType!!),
            ) { param ->
                if (!isSafeNativeEmbedding(param.args.getOrNull(0))) {
                    // insert(float[], long) is void. Supplying a result skips
                    // only this malformed native insertion.
                    param.result = null
                    Log.w(TAG, "  Skipped invalid semantic embedding")
                }
            }
            if (installed) {
                Log.w(TAG, "  SemanticIndexSafetyHooks installed")
            }
        } catch (error: Throwable) {
            Log.e(TAG, "  SemanticIndexSafetyHooks install failed: ${error.javaClass.simpleName}")
        }
    }

    internal fun isSafeNativeEmbedding(value: Any?): Boolean {
        val embedding = value as? FloatArray ?: return false
        return embedding.size == EMBEDDING_DIMENSIONS && embedding.all(Float::isFinite)
    }
}
