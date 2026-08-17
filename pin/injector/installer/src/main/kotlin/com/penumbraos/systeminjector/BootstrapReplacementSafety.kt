package com.penumbraos.systeminjector

import java.io.File

/** Validation shared by the physical-maintenance replacement finalizer and its unit tests. */
internal object BootstrapReplacementSafety {
    private val codePathPattern = Regex(
        "/data/app/com\\.penumbraos\\.systeminjector-(?:injected|replacement-[a-f0-9]{12}|rollback-[a-f0-9]{12})"
    )
    private val digestPattern = Regex("[a-f0-9]{64}")

    data class FinalizeRequest(val oldCodePath: String, val oldDigest: String)

    fun parseFinalizeArgument(arg: String?): FinalizeRequest {
        require(arg != null) { "Missing finalization argument" }
        val fields = arg.split(',')
        require(fields.size == 2) { "Invalid finalization argument" }
        val request = FinalizeRequest(fields[0], fields[1])
        require(request.oldCodePath.matches(codePathPattern)) { "Invalid inactive code path" }
        require(request.oldDigest.matches(digestPattern)) { "Invalid inactive APK digest" }
        return request
    }

    fun validateCurrentAndInactivePaths(
        currentBaseApkPath: String?,
        request: FinalizeRequest,
    ): File {
        require(currentBaseApkPath != null && currentBaseApkPath.endsWith("/base.apk")) {
            "Active injector has no valid base APK path"
        }
        val currentCodePath = currentBaseApkPath.removeSuffix("/base.apk")
        require(currentCodePath.matches(codePathPattern)) { "Active injector code path is uncontrolled" }
        require(currentCodePath.contains("-replacement-")) {
            "Finalization is only valid from an activated replacement"
        }
        require(currentCodePath != request.oldCodePath) {
            "Inactive and active injector paths are identical"
        }
        return File(request.oldCodePath)
    }
}
