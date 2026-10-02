package com.penumbraos.server

import android.content.Context
import android.net.Uri
import android.util.Log

internal object PersistentConfigVaultClient {

    private const val TAG = "PenumbraConfigVault"
    private val uri = Uri.parse("content://${PersistentConfigVaultProvider.AUTHORITY}")

    fun restoreIfAvailable(context: Context): Boolean {
        val result = call(context, PersistentConfigVaultProvider.METHOD_RESTORE)
        return when (result.status) {
            "absent" -> false
            "restored" -> {
                Log.w(TAG, "Configuration restored from generation ${result.generation}")
                true
            }
            else -> error("Unexpected config-vault restore status")
        }
    }

    fun commit(context: Context): CommitResult {
        val result = call(context, PersistentConfigVaultProvider.METHOD_COMMIT)
        check(result.status == "committed") { "Unexpected config-vault commit status" }
        Log.w(TAG, "Configuration committed as generation ${result.generation}")
        return CommitResult(result.generation, checkNotNull(result.configDigest))
    }

    private fun call(context: Context, method: String): Result {
        val bundle = context.contentResolver.call(uri, method, null, null)
            ?: error("Config-vault provider returned no result")
        val status = bundle.getString("status") ?: error("Config-vault result missing status")
        if (status == "error") {
            val kind = bundle.getString("error_kind") ?: "unknown"
            error("Config-vault $method failed ($kind)")
        }
        if (status == "absent") return Result(status, 0, null, null)

        val generation = bundle.getLong("generation", 0)
        val digest = bundle.getString("digest")
        val configDigest = bundle.getString("config_digest")
        check(
            generation > 0 &&
                isCanonicalDigest(digest) &&
                isCanonicalDigest(configDigest),
        ) {
            "Invalid config-vault success result"
        }
        return Result(status, generation, digest, configDigest)
    }

    private fun isCanonicalDigest(value: String?): Boolean =
        value?.length == 64 && value.all { it in '0'..'9' || it in 'a'..'f' }

    data class CommitResult(val generation: Long, val configDigest: String)

    private data class Result(
        val status: String,
        val generation: Long,
        val digest: String?,
        val configDigest: String?,
    )
}
