package com.penumbraos.hook

import org.json.JSONObject

internal data class StandaloneDockAllocatorGeometry(
    val objectSize: Int,
    val slabSize: Int,
    val order: Int,
    val objectsPerSlab: Int,
    val cpuPartial: Int,
)

internal data class StandaloneDockProfile(
    val profileId: String,
    val fingerprint: String,
    val kernelRelease: String,
    val kernelBuildMarker: String,
    val kernelMachine: String,
    val acceptedSlots: Set<String>,
    val acceptedAbis: Set<String>,
    val symbolsSha256: String,
    val allocator: StandaloneDockAllocatorGeometry,
) {
    companion object {
        fun parse(text: String): StandaloneDockProfile {
            val json = JSONObject(text)
            require(json.getInt("schema_version") == 2)
            val allocator = json.getJSONObject("allocator_geometry").let { geometry ->
                StandaloneDockAllocatorGeometry(
                    objectSize = geometry.getInt("object_size"),
                    slabSize = geometry.getInt("slab_size"),
                    order = geometry.getInt("order"),
                    objectsPerSlab = geometry.getInt("objects_per_slab"),
                    cpuPartial = geometry.getInt("cpu_partial"),
                )
            }
            require(
                allocator.objectSize > 0 &&
                    allocator.slabSize >= allocator.objectSize &&
                    allocator.order > 0 &&
                    allocator.objectsPerSlab > 0 &&
                    allocator.cpuPartial > 0 &&
                    allocator.objectsPerSlab.toLong() * allocator.slabSize <=
                    (4096L shl allocator.order),
            )
            val symbolsSha256 = json.getString("symbols_sha256")
            require(symbolsSha256.matches(Regex("[0-9a-f]{64}")))
            return StandaloneDockProfile(
                profileId = json.getString("profile_id"),
                fingerprint = json.getString("fingerprint"),
                kernelRelease = json.getString("kernel_release"),
                kernelBuildMarker = json.getString("kernel_build_marker"),
                kernelMachine = json.getString("kernel_machine"),
                acceptedSlots = json.stringSet("accepted_slots"),
                acceptedAbis = json.stringSet("accepted_abis"),
                symbolsSha256 = symbolsSha256,
                allocator = allocator,
            ).also { profile ->
                require(profile.profileId.isNotBlank())
                require(profile.fingerprint.isNotBlank())
                require(profile.acceptedSlots.isNotEmpty())
                require(profile.acceptedAbis.isNotEmpty())
            }
        }

        private fun JSONObject.stringSet(key: String): Set<String> {
            val array = getJSONArray(key)
            return (0 until array.length()).map { index -> array.getString(index) }.toSet()
        }
    }
}

internal data class StandaloneDockDeviceSnapshot(
    val fingerprint: String,
    val kernelRelease: String,
    val kernelVersion: String,
    val kernelMachine: String,
    val slot: String,
    val abi: String,
    val uid: String,
    val context: String,
    val selinux: String,
    val batteryLevel: Int?,
    val powered: Boolean?,
)

internal object StandaloneDockPreflight {
    const val MINIMUM_BATTERY = 20

    fun failures(
        snapshot: StandaloneDockDeviceSnapshot,
        profile: StandaloneDockProfile,
        observedPayloadSha256: String,
        expectedPayloadSha256: String,
    ): List<String> = buildList {
        if (snapshot.fingerprint != profile.fingerprint) add("fingerprint")
        if (snapshot.kernelRelease != profile.kernelRelease) add("kernel_release")
        if (!snapshot.kernelVersion.contains(profile.kernelBuildMarker)) add("kernel_build")
        if (snapshot.kernelMachine != profile.kernelMachine) add("kernel_machine")
        if (snapshot.slot !in profile.acceptedSlots) add("slot")
        if (snapshot.abi !in profile.acceptedAbis) add("abi")
        if (snapshot.uid != "2000") add("uid")
        if (snapshot.context != "u:r:shell:s0") add("context")
        if (snapshot.selinux != "Enforcing") add("selinux")
        if (snapshot.batteryLevel == null || snapshot.batteryLevel < MINIMUM_BATTERY) add("battery")
        if (snapshot.powered != true) add("power")
        if (
            !observedPayloadSha256.matches(Regex("[0-9a-f]{64}")) ||
            observedPayloadSha256 != expectedPayloadSha256
        ) {
            add("payload")
        }
    }
}

internal object StandaloneDockExploit {
    fun environment(
        profile: StandaloneDockProfile,
        runtimeTextBase: ULong,
        payloadPath: String,
    ): Map<String, String> = linkedMapOf(
        "AI_PIN_MM_OBJECT_SIZE" to profile.allocator.objectSize.toString(),
        "AI_PIN_MM_SLAB_SIZE" to profile.allocator.slabSize.toString(),
        "AI_PIN_MM_ORDER" to profile.allocator.order.toString(),
        "AI_PIN_MM_OBJS_PER_SLAB" to profile.allocator.objectsPerSlab.toString(),
        "AI_PIN_MM_CPU_PARTIAL" to profile.allocator.cpuPartial.toString(),
        "AI_PIN_PERF_RECLAIM_GATE" to "1",
        "AI_PIN_SLIDE_LEAK" to "2",
        "AI_PIN_KASLR_BASE" to "0x${runtimeTextBase.toString(16).padStart(16, '0')}",
        "AI_PIN_KASLR_PROOF" to "bugreport-v1",
        "AI_PIN_INSTALL_SU" to "1",
        "LD_PRELOAD" to payloadPath,
    )
}
