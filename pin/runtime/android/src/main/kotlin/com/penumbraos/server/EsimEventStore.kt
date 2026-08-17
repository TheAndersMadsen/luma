package com.penumbraos.server

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.ArrayDeque
import java.util.concurrent.CopyOnWriteArraySet

object EsimEventStore {

    private const val TAG = "PenumbraEsimEvents"
    private const val MAX_RECENT_EVENTS = 128
    private const val PROTECTED_T_MOBILE_NAME = "t-mobile"
    private const val PROTECTED_GSMA_TEST_PREFIX = "gsma test profile"

    private val recentEvents = ArrayDeque<JSONObject>()
    private val pendingProfiles = linkedMapOf<Int, String>()
    private val typedEventListeners = CopyOnWriteArraySet<(JSONObject) -> Unit>()

    @Volatile
    private var currentAction: String? = null

    @Volatile
    private var currentRequestId: String? = null

    @Volatile
    private var currentOperationToken: String? = null

    @Volatile
    private var lastIntentResult: String? = null

    @Volatile
    private var pendingActiveProfile: String? = null

    @Volatile
    private var pendingActiveIccid: String? = null

    @Volatile
    private var pendingProfileCount: Int? = null

    @Volatile
    private var currentImei: String? = null

    @Volatile
    private var currentEid: String? = null

    @Volatile
    private var activeProfileResultEmitted = false

    @Volatile
    private var activeIccidResultEmitted = false

    @Volatile
    private var deviceIdentifiersResultEmitted = false

    @Volatile
    private var activeDownloadRequestId: String? = null

    @Volatile
    private var activeDownloadAction: String? = null

    @Volatile
    private var activeDownloadTerminalResult: JSONObject? = null

    @Synchronized
    fun onEvent(event: JSONObject) {
        if (!EsimBridgeServer.operationGate.acceptsEvent(event)) {
            Log.w(TAG, "Quarantined unbound eSIM event type=${event.optString("type")}")
            return
        }
        appendRecent(event)
        Log.w(TAG, "Received event type=${event.optString("type")} action=${event.optString("action")}")

        when (event.optString("type")) {
            "esim.action_started" -> handleActionStarted(event)
            "esim.sysprop_update" -> handleSyspropUpdate(event)
            "esim.profile_mutation_result" -> handleProfileMutationResult(event)
            "esim.download_progress" -> handleDownloadProgress(event)
            "esim.download_result" -> handleDownloadResult(event)
        }
    }

    private fun isDownloadAction(action: String?): Boolean {
        return action == EsimRequestProtocol.ACTION_DOWNLOAD_VERIFY_AND_ENABLE_PROFILE ||
            action == EsimRequestProtocol.ACTION_DOWNLOAD_AND_ENABLE_PROFILE
    }

    private fun currentDownloadActionFor(event: JSONObject): String? {
        return event.optString("action").takeIf { it.isNotEmpty() } ?: currentAction
    }

    private fun matchesActiveDownload(event: JSONObject, action: String?): Boolean {
        if (!isDownloadAction(action)) {
            return false
        }
        val eventRequestId = event.optString("request_id").takeIf { it.isNotEmpty() }
        if (eventRequestId != null && eventRequestId != activeDownloadRequestId) {
            return false
        }
        return activeDownloadAction == null || activeDownloadAction == action
    }

    private fun downloadResultIsTerminalFailure(event: JSONObject, action: String?): Boolean {
        if (!matchesActiveDownload(event, action)) {
            return false
        }
        val result = event.optJSONObject("payload")?.optString("result")?.takeIf { it.isNotEmpty() } ?: return false
        return result != "success"
    }

    private fun mutationResultIsTerminalForDownload(event: JSONObject, action: String?): Boolean {
        if (action != EsimRequestProtocol.ACTION_DOWNLOAD_VERIFY_AND_ENABLE_PROFILE ||
            !matchesActiveDownload(event, action)
        ) {
            return false
        }
        val payload = event.optJSONObject("payload") ?: return false
        val operation = payload.optString("operation")
        val result = payload.optString("result")
        if (result.isEmpty()) {
            return false
        }
        return operation == "enable" || (operation == "unknown" && result == "error")
    }

    private fun isTerminalDownloadEvent(event: JSONObject): Boolean {
        val action = currentDownloadActionFor(event)
        return when (event.optString("type")) {
            "esim.download_result" -> downloadResultIsTerminalFailure(event, action)
            "esim.profile_mutation_result" -> mutationResultIsTerminalForDownload(event, action)
            else -> false
        }
    }

    private fun markDownloadTerminal(event: JSONObject) {
        activeDownloadTerminalResult = JSONObject(event.toString())
    }

    private fun hasDownloadTerminalFor(event: JSONObject): Boolean {
        val action = currentDownloadActionFor(event)
        if (!matchesActiveDownload(event, action)) {
            return false
        }
        return activeDownloadTerminalResult != null
    }

    fun addTypedEventListener(listener: (JSONObject) -> Unit) {
        typedEventListeners.add(listener)
    }

    fun removeTypedEventListener(listener: (JSONObject) -> Unit) {
        typedEventListeners.remove(listener)
    }

    private fun handleActionStarted(event: JSONObject) {
        val action = event.optString("action").takeIf { it.isNotEmpty() }
        currentAction = action
        currentRequestId = event.optString("request_id").takeIf { it.isNotEmpty() }
        currentOperationToken = event.optString("operation_token").takeIf { it.isNotEmpty() }
        notifyTypedEvent(event)
        when (action) {
            EsimRequestProtocol.ACTION_GET_PROFILES -> {
                pendingProfiles.clear()
                pendingProfileCount = null
                lastIntentResult = null
            }
            EsimRequestProtocol.ACTION_GET_ACTIVE_PROFILE -> {
                lastIntentResult = null
                pendingActiveProfile = null
                activeProfileResultEmitted = false
            }
            EsimRequestProtocol.ACTION_GET_ACTIVE_PROFILE_ICCID -> {
                lastIntentResult = null
                pendingActiveIccid = null
                activeIccidResultEmitted = false
            }
            EsimRequestProtocol.ACTION_GET_EID -> {
                lastIntentResult = null
                currentImei = null
                currentEid = null
                deviceIdentifiersResultEmitted = false
            }
            EsimRequestProtocol.ACTION_DOWNLOAD_VERIFY_AND_ENABLE_PROFILE,
            EsimRequestProtocol.ACTION_DOWNLOAD_AND_ENABLE_PROFILE -> {
                activeDownloadRequestId = currentRequestId
                activeDownloadAction = action
                activeDownloadTerminalResult = null
            }
        }
    }

    private fun handleSyspropUpdate(event: JSONObject) {
        val payload = event.optJSONObject("payload") ?: return
        val key = payload.optString("key")
        val value = payload.optString("value")

        when {
            key.startsWith("humane.esim.Profile") -> {
                val index = key.removePrefix("humane.esim.Profile").toIntOrNull() ?: return
                pendingProfiles[index] = value
                maybeSynthesizeProfilesResult()
            }
            key == "humane.esim.NmbrOfProfiles" -> {
                pendingProfileCount = value.toIntOrNull()
                maybeSynthesizeProfilesResult()
            }
            key == "humane.esim.lastintent.result" -> {
                lastIntentResult = value
                maybeSynthesizeProfilesResult()
                maybeSynthesizeActiveProfileResult()
                maybeSynthesizeActiveIccidResult()
                maybeSynthesizeDeviceIdentifiersResult()
            }
            key == "humane.esim.ActiveProfile" -> {
                pendingActiveProfile = value.takeIf { it.isNotEmpty() }
                maybeSynthesizeActiveProfileResult()
            }
            key == "humane.esim.ICCID" -> {
                pendingActiveIccid = value.takeIf { it.isNotEmpty() }
                maybeSynthesizeActiveIccidResult()
            }
            key == "humane.esim.EID" -> {
                currentEid = value.takeIf { it.isNotEmpty() }
                maybeSynthesizeDeviceIdentifiersResult()
            }
            key == "humane.esim.IMEI" -> {
                currentImei = value.takeIf { it.isNotEmpty() }
                maybeSynthesizeDeviceIdentifiersResult()
            }
        }
    }

    private fun handleProfileMutationResult(event: JSONObject) {
        if (hasDownloadTerminalFor(event)) {
            Log.w(TAG, "Ignoring profile_mutation_result after terminal result")
            return
        }
        if (isTerminalDownloadEvent(event)) {
            markDownloadTerminal(event)
        }
        Log.w(TAG, "Received profile_mutation_result")
        notifyTypedEvent(event)
    }

    private fun handleDownloadProgress(event: JSONObject) {
        if (hasDownloadTerminalFor(event)) {
            Log.w(TAG, "Ignoring download_progress after terminal result")
            return
        }
        Log.w(TAG, "Received download_progress")
        notifyTypedEvent(event)
    }

    private fun handleDownloadResult(event: JSONObject) {
        if (hasDownloadTerminalFor(event)) {
            Log.w(TAG, "Ignoring duplicate download_result")
            return
        }
        if (isTerminalDownloadEvent(event)) {
            markDownloadTerminal(event)
        }
        Log.w(TAG, "Received download_result")
        notifyTypedEvent(event)
    }

    private fun maybeSynthesizeProfilesResult() {
        if (currentAction != EsimRequestProtocol.ACTION_GET_PROFILES) return
        if (lastIntentResult != "getProfile success") return

        val expectedCount = pendingProfileCount ?: return
        if (pendingProfiles.size < expectedCount) return

        val profiles = JSONArray()
        for (index in 0 until expectedCount) {
            val raw = pendingProfiles[index] ?: return
            val parts = raw.split(",", limit = 5)
            if (parts.size < 5) return

            profiles.put(
                JSONObject()
                    .put("name", parts[0])
                    .put("state", parts[1])
                    .put("iccid", parts[2])
                    .put("service_provider", parts[3])
                    .put("nickname", parts[4])
                    .put("protected", isDeletionProtected(parts[0]))
            )
        }

        val event = baseEvent("esim.profiles_result")
            .put(
                "payload",
                JSONObject()
                    .put("result", "success")
                    .put("count", expectedCount)
                    .put("profiles", profiles)
                    .put("raw_lastintent_result", lastIntentResult)
            )

        appendRecent(event)
        Log.w(TAG, "Synthesized profiles_result count=$expectedCount")
        notifyTypedEvent(event)
    }

    private fun maybeSynthesizeActiveProfileResult() {
        if (currentAction != EsimRequestProtocol.ACTION_GET_ACTIVE_PROFILE) return
        if (activeProfileResultEmitted) return

        val activeProfile = pendingActiveProfile

        if (activeProfile != null && lastIntentResult == "Get Ative profile success") {
            val parts = activeProfile.split(",", limit = 5)
            if (parts.size < 5) return

            val event = baseEvent("esim.active_profile_result")
                .put(
                    "payload",
                    JSONObject()
                        .put("result", "success")
                        .put(
                            "profile",
                            JSONObject()
                                .put("name", parts[0])
                                .put("state", parts[1])
                                .put("iccid", parts[2])
                                .put("service_provider", parts[3])
                                .put("nickname", parts[4])
                                .put("protected", isDeletionProtected(parts[0]))
                        )
                        .put("raw_lastintent_result", lastIntentResult)
                )

            appendRecent(event)
            activeProfileResultEmitted = true
            Log.w(TAG, "Synthesized active_profile_result success")
            notifyTypedEvent(event)
            return
        }

        if (lastIntentResult == "No Active profile") {
            val event = baseEvent("esim.active_profile_result")
                .put("payload", JSONObject().put("result", "no_active_profile"))
            appendRecent(event)
            activeProfileResultEmitted = true
            Log.w(TAG, "Synthesized active_profile_result no_active_profile")
            notifyTypedEvent(event)
        }
    }

    private fun maybeSynthesizeActiveIccidResult() {
        if (currentAction != EsimRequestProtocol.ACTION_GET_ACTIVE_PROFILE_ICCID) return
        if (activeIccidResultEmitted) return

        val iccid = pendingActiveIccid

        if (!iccid.isNullOrEmpty() && lastIntentResult == "Get Ative profile ICCID success") {
            val event = baseEvent("esim.active_iccid_result")
                .put(
                    "payload",
                    JSONObject()
                        .put("result", "success")
                        .put("iccid", iccid)
                        .put("raw_lastintent_result", lastIntentResult)
                )
            appendRecent(event)
            activeIccidResultEmitted = true
            Log.w(TAG, "Synthesized active_iccid_result success")
            notifyTypedEvent(event)
            return
        }

        if (lastIntentResult == "No Active profile") {
            val event = baseEvent("esim.active_iccid_result")
                .put("payload", JSONObject().put("result", "no_active_profile"))
            appendRecent(event)
            activeIccidResultEmitted = true
            Log.w(TAG, "Synthesized active_iccid_result no_active_profile")
            notifyTypedEvent(event)
        }
    }

    private fun maybeSynthesizeDeviceIdentifiersResult() {
        if (currentAction != EsimRequestProtocol.ACTION_GET_EID) return
        if (deviceIdentifiersResultEmitted) return

        val eid = currentEid

        if (!eid.isNullOrEmpty() && lastIntentResult == "Get EID success") {
            val event = baseEvent("esim.device_identifiers_result")
                .put(
                    "payload",
                    JSONObject()
                        .put("result", "success")
                        .put("eid", eid)
                        .put("imei", currentImei?.let { it } ?: JSONObject.NULL)
                        .put("raw_lastintent_result", lastIntentResult)
                )
            appendRecent(event)
            deviceIdentifiersResultEmitted = true
            Log.w(TAG, "Synthesized device_identifiers_result success")
            notifyTypedEvent(event)
        }
    }

    private fun notifyTypedEvent(event: JSONObject) {
        val snapshot = JSONObject(event.toString())
        if (!EsimBridgeServer.operationGate.acceptsEvent(snapshot)) {
            Log.w(TAG, "Quarantined unbound typed eSIM event type=${snapshot.optString("type")}")
            return
        }
        for (listener in typedEventListeners) {
            try {
                listener(snapshot)
            } catch (t: Throwable) {
                Log.w(TAG, "Typed event listener failed", t)
            }
        }
        EsimBridgeServer.operationGate.markDelivered(snapshot)
    }

    private fun isDeletionProtected(profileName: String?): Boolean {
        val normalized = profileName?.trim()?.lowercase().orEmpty()
        if (normalized.isEmpty()) return false
        return normalized.startsWith(PROTECTED_T_MOBILE_NAME) || normalized.startsWith(PROTECTED_GSMA_TEST_PREFIX)
    }

    private fun baseEvent(type: String): JSONObject {
        return JSONObject()
            .put("version", 1)
            .put("type", type)
            .put("ts_ms", System.currentTimeMillis())
            .put("source_process", "com.penumbraos.server")
            .put("source_pid", android.os.Process.myPid())
            .put("request_id", currentRequestId?.let { it } ?: JSONObject.NULL)
            .put("action", currentAction)
            .put("operation_token", currentOperationToken?.let { it } ?: JSONObject.NULL)
    }

    private fun appendRecent(event: JSONObject) {
        recentEvents.addLast(JSONObject(event.toString()))
        while (recentEvents.size > MAX_RECENT_EVENTS) {
            recentEvents.removeFirst()
        }
    }
}
