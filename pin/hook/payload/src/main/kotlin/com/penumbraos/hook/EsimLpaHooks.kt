package com.penumbraos.hook

import android.content.Context
import android.content.Intent
import android.util.Log
import com.penumbraos.stockaibus.contract.StockSymbols
// DISABLED per R-006: IMEI collection disabled; these imports are only used by the
// commented-out emitImeiIdentifier / getCurrentImei methods.
// import android.annotation.SuppressLint
// import android.content.pm.PackageManager
// import android.os.Build
// import android.telephony.TelephonyManager
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Method
import java.lang.reflect.Proxy
import java.util.ArrayList
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Hooks for the eSIM LPA process (package: humane.connectivity.esimlpa).
 */
object EsimLpaHooks {

    internal enum class DeleteBlockReason {
        PROTECTED_PROFILE,
        ACTIVE_PROFILE,
        UNVERIFIED_PROFILE_STATE,
    }

    private const val TAG = "PenumbraHook"
    private const val MAX_ITERATIONS = 200
    private const val PROTECTED_T_MOBILE_NAME = "t-mobile"
    private const val PROTECTED_GSMA_TEST_PREFIX = "gsma test profile"
    // DISABLED per R-006: IMEI collection disabled
    // private const val DEVICE_IDENTIFIER_IMEI_KEY = "humane.esim.IMEI"
    private const val BRIDGE_AUTH_TOKEN_EXTRA = "penumbra_bridge_auth_token"
    private const val OPERATION_TOKEN_EXTRA = "penumbra_operation_token"
    private val LONG_IDENTIFIER_PATTERN = Regex("\\d{10,}")

    // DISABLED per R-006: carrier-lock bypass disabled
    // private const val HUMANE_HEX = "48756D616E65"

    /**
     * Scoping flag for the carrier lock bypass. getProfileName() hook patch
     * only applies when this is flag is true. Set to true at the
     * start of downloadVerifyAndEnableProfileAPI, cleared at the start of
     * every onStartCommand (every new intent).
     */
    private val bypassActive = AtomicBoolean(false)

    // -- Cached reflection handles (resolved once in install()) --

    // Util static methods
    private lateinit var getBERLengthInIntMethod: Method      // Util.getBERLengthInInt(String, int)
    private lateinit var getBERLengthSizeStrMethod: Method     // Util.getBERLengthSizeInNibbles(String, int)
    private lateinit var getBERLengthSizeIntMethod: Method     // Util.getBERLengthSizeInNibbles(int)

    // FillerEngine private fill* methods
    private lateinit var fillIccidMethod: Method
    private lateinit var fillHexStringMethod: Method
    private lateinit var fillIconTypeMethod: Method
    private lateinit var fillIconMethod: Method
    private lateinit var fillProfileClassMethod: Method
    private lateinit var fillPprIdsMethod: Method
    private lateinit var fillNotificationConfigInfoMethod: Method
    private lateinit var fillOperatorIdMethod: Method

    // Data class getSize methods
    private lateinit var iccidGetSizeMethod: Method
    private lateinit var hexStringGetSizeMethod: Method
    private lateinit var iconTypeGetSizeMethod: Method
    private lateinit var profileClassGetSizeMethod: Method
    private lateinit var pprIdsGetSizeMethod: Method
    private lateinit var operatorIdGetSizeMethod: Method
    private lateinit var notifConfigGetSizeMethod: Method  // on NotificationConfigurationInformation

    // StoreMetadataRequest setters
    private lateinit var smrSetIccid: Method
    private lateinit var smrSetServiceProviderName: Method
    private lateinit var smrSetProfileName: Method
    private lateinit var smrSetIconType: Method
    private lateinit var smrSetIcon: Method
    private lateinit var smrSetProfileClass: Method
    private lateinit var smrSetProfilePolicyRules: Method
    private lateinit var smrSetNotificationConfigInfo: Method
    private lateinit var smrSetProfileOwner: Method

    // Classes
    private lateinit var storeMetadataRequestClass: Class<*>

    fun install(cl: ClassLoader) {
        Log.w(TAG, "Installing eSIM LPA hooks...")

        try {
            TcmSilencer.install(cl)
            resolveClasses(cl)
            hookActivationCodeLogRedaction()
            hookActionCapture(cl)
            hookSyspropCapture(cl)
            hookProfileMutationCapture(cl)
            hookDownloadCapture(cl)
            hookDeleteProtection(cl)
            // DISABLED per R-006: carrier-lock bypass is a trust decision substitution
            // hookCarrierLock(cl)
            hookBF25Parser(cl)
            Log.w(TAG, "eSIM LPA hooks installed")
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to install eSIM LPA hooks", t)
        }
    }

    private fun hookActivationCodeLogRedaction() {
        try {
            HookUtils.hookMethodBefore(
                Log::class.java,
                "d",
                arrayOf(String::class.java, String::class.java),
            ) { param ->
                val message = param.args.getOrNull(1) as? String ?: return@hookMethodBefore
                param.args[1] = redactSensitiveLpaLogMessage(message)
            }
            Log.w(TAG, "  eSIM sensitive log redaction installed")
        } catch (t: Throwable) {
            // Log redaction is defense in depth. A framework-method hooking
            // restriction must never prevent the authoritative mutation and
            // active-profile deletion guards below from installing.
            Log.w(TAG, "  eSIM sensitive log redaction unavailable (${t.javaClass.simpleName})")
        }
    }

    internal fun redactSensitiveLpaLogMessage(message: String): String {
        val marker = "activationCode:"
        val markerIndex = message.indexOf(marker, ignoreCase = true)
        val activationRedacted = if (markerIndex < 0) {
            message
        } else {
            message.substring(0, markerIndex) + marker + " [REDACTED]"
        }
        return LONG_IDENTIFIER_PATTERN.replace(activationRedacted, "[REDACTED]")
    }

    private fun resolveClasses(cl: ClassLoader) {
        val fillerEngineClass = cl.loadClass("es.com.valid.lib_lpa.controler.FillerEngine")
        val utilClass = cl.loadClass("es.com.valid.lib_lpa.controler.Util")
        storeMetadataRequestClass = cl.loadClass("es.com.valid.lib_lpa.dataClasses.StoreMetadataRequest")
        val iccidClass = cl.loadClass("es.com.valid.lib_lpa.dataClasses.Iccid")
        val hexStringClass = cl.loadClass("es.com.valid.lib_lpa.dataClasses.HexString")
        val iconTypeClass = cl.loadClass("es.com.valid.lib_lpa.dataClasses.IconType")
        val profileClassClass = cl.loadClass("es.com.valid.lib_lpa.dataClasses.ProfileClass")
        val pprIdsClass = cl.loadClass("es.com.valid.lib_lpa.dataClasses.PprIds")
        val notifConfigClass = cl.loadClass("es.com.valid.lib_lpa.dataClasses.NotificationConfigurationInformation")
        val operatorIdClass = cl.loadClass("es.com.valid.lib_lpa.dataClasses.OperatorId")

        // Util static methods
        getBERLengthInIntMethod = utilClass.getDeclaredMethod("getBERLengthInInt", String::class.java, Int::class.javaPrimitiveType!!)
        getBERLengthInIntMethod.isAccessible = true
        getBERLengthSizeStrMethod = utilClass.getDeclaredMethod("getBERLengthSizeInNibbles", String::class.java, Int::class.javaPrimitiveType!!)
        getBERLengthSizeStrMethod.isAccessible = true
        getBERLengthSizeIntMethod = utilClass.getDeclaredMethod("getBERLengthSizeInNibbles", Int::class.javaPrimitiveType!!)
        getBERLengthSizeIntMethod.isAccessible = true

        // FillerEngine private methods
        fillIccidMethod = fillerEngineClass.getDeclaredMethod("fillIccid", String::class.java, Int::class.javaPrimitiveType!!)
        fillIccidMethod.isAccessible = true
        fillHexStringMethod = fillerEngineClass.getDeclaredMethod("fillHexString", String::class.java, Int::class.javaPrimitiveType!!)
        fillHexStringMethod.isAccessible = true
        fillIconTypeMethod = fillerEngineClass.getDeclaredMethod("fillIconType", String::class.java, Int::class.javaPrimitiveType!!)
        fillIconTypeMethod.isAccessible = true
        fillIconMethod = fillerEngineClass.getDeclaredMethod("fillIcon", String::class.java, Int::class.javaPrimitiveType!!)
        fillIconMethod.isAccessible = true
        fillProfileClassMethod = fillerEngineClass.getDeclaredMethod("fillProfileClass", String::class.java, Int::class.javaPrimitiveType!!)
        fillProfileClassMethod.isAccessible = true
        fillPprIdsMethod = fillerEngineClass.getDeclaredMethod("fillPprIds", String::class.java, Int::class.javaPrimitiveType!!)
        fillPprIdsMethod.isAccessible = true
        fillNotificationConfigInfoMethod = fillerEngineClass.getDeclaredMethod("fillNotificationConfigurationInfo", String::class.java, Int::class.javaPrimitiveType!!)
        fillNotificationConfigInfoMethod.isAccessible = true
        fillOperatorIdMethod = fillerEngineClass.getDeclaredMethod("fillOperatorId", String::class.java, Int::class.javaPrimitiveType!!)
        fillOperatorIdMethod.isAccessible = true

        // getSize methods on data classes
        iccidGetSizeMethod = iccidClass.getMethod("getSize")
        hexStringGetSizeMethod = hexStringClass.getMethod("getSize")
        iconTypeGetSizeMethod = iconTypeClass.getMethod("getSize")
        profileClassGetSizeMethod = profileClassClass.getMethod("getSize")
        pprIdsGetSizeMethod = pprIdsClass.getMethod("getSize")
        operatorIdGetSizeMethod = operatorIdClass.getMethod("getSize")
        notifConfigGetSizeMethod = notifConfigClass.getMethod("getSize")

        // StoreMetadataRequest setters
        smrSetIccid = storeMetadataRequestClass.getMethod("setIccid", iccidClass)
        smrSetServiceProviderName = storeMetadataRequestClass.getMethod("setServiceProviderName", hexStringClass)
        smrSetProfileName = storeMetadataRequestClass.getMethod("setProfileName", hexStringClass)
        smrSetIconType = storeMetadataRequestClass.getMethod("setIconType", iconTypeClass)
        smrSetIcon = storeMetadataRequestClass.getMethod("setIcon", ByteArray::class.java)
        smrSetProfileClass = storeMetadataRequestClass.getMethod("setProfileClass", profileClassClass)
        smrSetProfilePolicyRules = storeMetadataRequestClass.getMethod("setProfilePolicyRules", pprIdsClass)
        smrSetNotificationConfigInfo = storeMetadataRequestClass.getMethod(
            "setNotificationConfigurationInfo",
            java.lang.reflect.Array.newInstance(notifConfigClass, 0).javaClass
        )
        smrSetProfileOwner = storeMetadataRequestClass.getMethod("setProfileOwner", operatorIdClass)

        Log.w(TAG, "  eSIM LPA reflection resolved successfully")
    }

    private fun hookActionCapture(cl: ClassLoader) {
        val factoryServiceClass = cl.loadClass(StockSymbols.EsimLpa.FACTORY_SERVICE_CLASS)

        HookUtils.hookMethodBefore(
            factoryServiceClass,
            "onStartCommand",
            arrayOf(Intent::class.java, Int::class.javaPrimitiveType!!, Int::class.javaPrimitiveType!!)
        ) { param ->
            val intent = param.args[0] as? Intent
            if (intent == null) {
                // Stock returns START_STICKY but dereferences a null restart
                // Intent, creating a crash/restart loop after profile changes.
                // There is no operation to resume and no request-scoped bridge
                // credential on this callback, so end the empty restart cleanly.
                EsimOperationContext.clear()
                bypassActive.set(false)
                param.result = android.app.Service.START_NOT_STICKY
                Log.w(TAG, "Ignored empty sticky restart for eSIM LPA service")
                return@hookMethodBefore
            }
            val deliveredBridgeToken = try {
                EsimBridgeAuthentication.canonicalDeliveredTokenOrNull(
                    intent.getStringExtra(BRIDGE_AUTH_TOKEN_EXTRA),
                )
            } catch (_: Throwable) {
                null
            }
            val operationToken = intent.getStringExtra(OPERATION_TOKEN_EXTRA)
            // Keep the bridge credential out of the stock service's intent
            // handling and any later diagnostic rendering of its extras.
            intent.removeExtra(BRIDGE_AUTH_TOKEN_EXTRA)
            intent.removeExtra(OPERATION_TOKEN_EXTRA)
            (param.thisObject as? Context)?.let(EsimEventEmitter::setContext)
            val source = intent.getStringExtra("penumbra_source")
            val operation = EsimOperationContext.begin(
                action = intent.action,
                requestId = intent.getStringExtra("penumbra_request_id"),
                operationToken = operationToken,
                iccid = intent.getStringExtra("iccid"),
                nickname = intent.getStringExtra("Nickname"),
                source = source,
                bridgeAuthToken = deliveredBridgeToken,
                activationCodeProvided = intent.hasExtra("activationCode"),
            )
            if (source == "rust" && operation == null) {
                param.result = android.app.Service.START_NOT_STICKY
                Log.w(TAG, "Rejected unbound Penumbra eSIM operation")
                return@hookMethodBefore
            }
            // The activation code stays only in the LPA Intent. The event gets
            // a presence bit and never retains the provisioning credential.
            if (operation != null) {
                EsimEventEmitter.emitActionStarted(operation)
            }
            // DISABLED per R-006: IMEI is a hardware device identifier; do not collect it from the LPA process
            // if (operation?.action == "humane.connectivity.esimlpa.getEID") {
            //     emitImeiIdentifier(param.thisObject, operation)
            // }
        }

        Log.w(TAG, "  eSIM action capture installed")
    }

    private fun hookSyspropCapture(cl: ClassLoader) {
        val factoryServiceClass = cl.loadClass(StockSymbols.EsimLpa.FACTORY_SERVICE_CLASS)

        HookUtils.hookMethodAfter(
            factoryServiceClass,
            "setSysProp",
            arrayOf(String::class.java, String::class.java)
        ) { param ->
            val key = param.args[0] as? String ?: return@hookMethodAfter
            val value = param.args[1] as? String
            val operation = EsimOperationContext.snapshot() ?: return@hookMethodAfter
            EsimEventEmitter.emitSyspropUpdate(operation, key, value)
        }

        Log.w(TAG, "  eSIM sysprop capture installed")
    }

    private fun hookProfileMutationCapture(cl: ClassLoader) {
        val profileInfoControlerClass = cl.loadClass("es.com.valid.lib_lpa.controler.ProfileInfoControler")
        val listenerInterfaceClass = cl.loadClass("es.com.valid.lib_lpa.controler.ProfileInfoControler\$ProfileInfoControlerListener")

        HookUtils.hookMethodBefore(
            profileInfoControlerClass,
            "setProfileInfoControlerListener",
            arrayOf(listenerInterfaceClass)
        ) { param ->
            val listener = param.args[0] ?: return@hookMethodBefore
            val registrationOperation = EsimOperationContext.snapshot()
            param.args[0] = wrapListener(listenerInterfaceClass, listener) { methodName, args ->
                val operation = registrationOperation ?: EsimOperationContext.snapshot()
                    ?: return@wrapListener
                val message = args?.getOrNull(0) as? String
                when (methodName) {
                    "onEnable" -> EsimEventEmitter.emitProfileMutationResult(
                        operation,
                        "enable",
                        classifyMutationResult(message),
                        message,
                    )
                    "onDisable" -> EsimEventEmitter.emitProfileMutationResult(
                        operation,
                        "disable",
                        classifyMutationResult(message),
                        message,
                    )
                    "onDelete" -> EsimEventEmitter.emitProfileMutationResult(
                        operation,
                        "delete",
                        classifyMutationResult(message),
                        message,
                    )
                    "onsetNickName" -> EsimEventEmitter.emitProfileMutationResult(
                        operation,
                        "set_nickname",
                        classifyMutationResult(message),
                        message,
                    )
                    "onError" -> EsimEventEmitter.emitProfileMutationResult(
                        operation,
                        currentMutationOperation(operation),
                        "error",
                        message,
                    )
                }
            }
        }

        Log.w(TAG, "  eSIM profile mutation capture installed")
    }

    private fun isDownloadVerifyEnableAction(operation: EsimOperationSnapshot): Boolean {
        return operation.action == "humane.connectivity.esimlpa.downloadVerifyAndEnableProfile"
    }

    private fun currentMutationOperation(operation: EsimOperationSnapshot): String {
        return when (operation.action) {
            "humane.connectivity.esimlpa.enableProfile",
            "humane.connectivity.esimlpa.downloadVerifyAndEnableProfile" -> "enable"
            "humane.connectivity.esimlpa.disableProfile",
            "humane.connectivity.esimlpa.disableActiveProfile" -> "disable"
            "humane.connectivity.esimlpa.deleteProfile" -> "delete"
            "humane.connectivity.esimlpa.setNickname" -> "set_nickname"
            else -> "unknown"
        }
    }

    private fun classifyMutationResult(message: String?): String {
        val normalized = message?.lowercase().orEmpty()
        return when {
            normalized.isEmpty() -> "success"
            "error" in normalized || "fail" in normalized || "not exist" in normalized -> "error"
            else -> "success"
        }
    }

    private fun hookDownloadCapture(cl: ClassLoader) {
        val downloadControlerClass = cl.loadClass("es.com.valid.lib_lpa.controler.DownloadControler")
        val downloadListenerInterfaceClass = cl.loadClass("es.com.valid.lib_lpa.controler.DownloadControler\$DownloadControlerListener")
        val communicationManagerClass = cl.loadClass("es.com.valid.lib_lpa.cardCommunication.CommunicationManager")
        val communicationManagerListenerClass = cl.loadClass("es.com.valid.lib_lpa.cardCommunication.CommunicationManager\$CommunicationManagerListener")
        val getIccidMethod = storeMetadataRequestClass.getMethod("getIccid")

        HookUtils.hookMethodBefore(
            downloadControlerClass,
            "setDownloadControlerListener",
            arrayOf(downloadListenerInterfaceClass)
        ) { param ->
            val listener = param.args[0] ?: return@hookMethodBefore
            val registrationOperation = EsimOperationContext.snapshot()
            param.args[0] = wrapListener(downloadListenerInterfaceClass, listener) { methodName, args ->
                val operation = registrationOperation ?: EsimOperationContext.snapshot()
                    ?: return@wrapListener
                when (methodName) {
                    "onProgress" -> EsimEventEmitter.emitDownloadProgress(
                        operation,
                        "download_progress",
                        args?.getOrNull(0) as? Int,
                    )
                    "onMutualAuthenticationCompleted" -> {
                        val storeMetadataRequest = args?.getOrNull(0)
                        val iccid = try {
                            val iccidObject = if (storeMetadataRequest == null) {
                                null
                            } else {
                                getIccidMethod.invoke(storeMetadataRequest)
                            }
                            iccidObject?.javaClass?.getMethod("getValueRotated")?.invoke(iccidObject) as? String
                        } catch (t: Throwable) {
                            Log.w(TAG, "  Failed to extract download ICCID (${t.javaClass.simpleName})")
                            null
                        }
                        operation.downloadIccid = iccid
                        EsimEventEmitter.emitDownloadProgress(
                            operation,
                            "mutual_auth_completed",
                            message = iccid,
                        )
                    }
                    "onFinished" -> {
                        val message = args?.getOrNull(0) as? String
                        EsimEventEmitter.emitDownloadProgress(operation, "finished", message = message)
                        if (!isDownloadVerifyEnableAction(operation)) {
                            EsimEventEmitter.emitDownloadResult(operation, "success", message)
                        }
                    }
                    "onError" -> {
                        val message = args?.getOrNull(0) as? String
                        EsimEventEmitter.emitDownloadResult(
                            operation,
                            classifyDownloadResult(message),
                            message,
                        )
                    }
                }
            }
        }

        HookUtils.hookMethodBefore(
            communicationManagerClass,
            "setCommunicationManagerListener",
            arrayOf(communicationManagerListenerClass)
        ) { param ->
            val listener = param.args[0] ?: return@hookMethodBefore
            val registrationOperation = EsimOperationContext.snapshot()
            param.args[0] = wrapListener(communicationManagerListenerClass, listener) { methodName, args ->
                val operation = registrationOperation ?: EsimOperationContext.snapshot()
                    ?: return@wrapListener
                when (methodName) {
                    "onProgress" -> EsimEventEmitter.emitDownloadProgress(
                        operation,
                        "communication_progress",
                        args?.getOrNull(0) as? Int,
                    )
                    "onError" -> {
                        val message = args?.getOrNull(0) as? String
                        EsimEventEmitter.emitDownloadResult(operation, "error", message)
                    }
                }
            }
        }

        Log.w(TAG, "  eSIM download capture installed")
    }

    private fun classifyDownloadResult(message: String?): String {
        val normalized = message?.lowercase().orEmpty()
        return when {
            "disallowed" in normalized -> "disallowed_profile"
            else -> "error"
        }
    }

    private fun hookDeleteProtection(cl: ClassLoader) {
        val factoryServiceClass = cl.loadClass(StockSymbols.EsimLpa.FACTORY_SERVICE_CLASS)
        val communicationManagerClass = cl.loadClass("es.com.valid.lib_lpa.cardCommunication.CommunicationManager")
        val profileInfoClass = cl.loadClass("es.com.valid.lib_lpa.dataClasses.ProfileInfo")
        val hexStringClass = cl.loadClass("es.com.valid.lib_lpa.dataClasses.HexString")
        val utilClass = cl.loadClass("es.com.valid.lib_lpa.common.Util")

        val getApplicationContextMethod = factoryServiceClass.getMethod("getApplicationContext")
        val getInstanceMethod = communicationManagerClass.getMethod("getInstance", android.content.Context::class.java)
        val openConnectionMethod = communicationManagerClass.getMethod("openConnection")
        val closeConnectionMethod = communicationManagerClass.getMethod("closeConnection")
        val getProfileListAsArrayMethod = communicationManagerClass.getMethod("getProfileListAsArray")
        val getIccidMethod = profileInfoClass.getMethod("getIccid")
        val getProfileNameMethod = profileInfoClass.getMethod("getProfileName")
        val getProfileStateMethod = profileInfoClass.getMethod("getProfileState")
        val getValueRotatedMethod = cl.loadClass("es.com.valid.lib_lpa.dataClasses.Iccid").getMethod("getValueRotated")
        val getHexValueMethod = hexStringClass.getMethod("getValue")
        val hexToAsciiMethod = utilClass.getMethod("HexToAscII", String::class.java)
        val getProfileStateValueStringMethod =
            cl.loadClass("es.com.valid.lib_lpa.dataClasses.ProfileState").getMethod("getValueString")

        HookUtils.hookMethodBefore(
            factoryServiceClass,
            "deleteProfileUtil",
            arrayOf(String::class.java)
        ) { param ->
            val operation = EsimOperationContext.snapshot()
            fun blockUnverifiedProfile(logReason: String) {
                Log.w(TAG, "  Delete blocked because $logReason")
                if (operation != null) {
                    EsimEventEmitter.emitProfileMutationResult(
                        operation,
                        "delete",
                        "unverified_profile",
                        "Deletion blocked because the exact target profile could not be verified as disabled.",
                    )
                }
                param.result = null
            }

            val targetIccid = (param.args.getOrNull(0) as? String)
                ?.takeIf(::deleteRequestIdentityIsUsable)
                ?: run {
                    blockUnverifiedProfile("the target identity was unavailable")
                    return@hookMethodBefore
                }
            val context = getApplicationContextMethod.invoke(param.thisObject) as? android.content.Context
                ?: run {
                    blockUnverifiedProfile("the LPA context was unavailable")
                    return@hookMethodBefore
                }
            val communicationManager = getInstanceMethod.invoke(null, context)
                ?: run {
                    blockUnverifiedProfile("the profile manager was unavailable")
                    return@hookMethodBefore
                }

            var opened = false
            try {
                openConnectionMethod.invoke(communicationManager)
                opened = true
                @Suppress("UNCHECKED_CAST")
                val profiles = getProfileListAsArrayMethod.invoke(communicationManager) as? ArrayList<Any>
                if (profiles == null) {
                    blockUnverifiedProfile("the profile inventory was unavailable")
                    return@hookMethodBefore
                }
                val profile = profiles.firstOrNull { candidate ->
                    val iccidObject = getIccidMethod.invoke(candidate) ?: return@firstOrNull false
                    val rotated = getValueRotatedMethod.invoke(iccidObject) as? String ?: return@firstOrNull false
                    rotated.equals(targetIccid, ignoreCase = true)
                }
                if (profile == null) {
                    blockUnverifiedProfile("the exact target profile was not found")
                    return@hookMethodBefore
                }

                val profileName = decodeProfileName(getProfileNameMethod.invoke(profile), getHexValueMethod, hexToAsciiMethod)
                val profileState = runCatching {
                    val state = getProfileStateMethod.invoke(profile) ?: return@runCatching null
                    getProfileStateValueStringMethod.invoke(state) as? String
                }.getOrNull()
                val blockReason = deletionBlockReason(profileName, profileState)
                    ?: return@hookMethodBefore
                val (result, message) = when (blockReason) {
                    DeleteBlockReason.PROTECTED_PROFILE -> {
                        val protectedName = profileName?.ifBlank { null } ?: "unknown"
                        "protected" to "Deletion blocked for protected profile: $protectedName"
                    }
                    DeleteBlockReason.ACTIVE_PROFILE ->
                        "active_profile" to
                            "Deletion blocked for the enabled profile. Activate another profile first."
                    DeleteBlockReason.UNVERIFIED_PROFILE_STATE ->
                        "unverified_profile" to
                            "Deletion blocked because the target profile state could not be verified as disabled."
                }

                Log.w(TAG, "  Delete blocked by profile safety policy: $blockReason")
                if (operation != null) {
                    EsimEventEmitter.emitProfileMutationResult(operation, "delete", result, message)
                }
                param.result = null
            } catch (t: Throwable) {
                blockUnverifiedProfile(
                    "profile safety inspection failed (${t.javaClass.simpleName})",
                )
            } finally {
                if (opened) {
                    try {
                        closeConnectionMethod.invoke(communicationManager)
                    } catch (closeError: Throwable) {
                        Log.w(TAG, "  Failed to close connection after delete protection check", closeError)
                    }
                }
            }
        }

        Log.w(TAG, "  eSIM delete protection installed")
    }

    internal fun wrapListener(
        listenerInterface: Class<*>,
        delegate: Any,
        afterInvocation: (String, Array<out Any?>?) -> Unit,
    ): Any = Proxy.newProxyInstance(
        listenerInterface.classLoader,
        arrayOf(listenerInterface),
    ) { _, method, args ->
        val result = try {
            method.invoke(delegate, *(args ?: emptyArray()))
        } catch (failure: InvocationTargetException) {
            throw failure.targetException
        }
        if (method.declaringClass != Any::class.java) {
            afterInvocation(method.name, args)
        }
        result
    }

    // DISABLED per R-006: IMEI is a hardware device identifier; collecting it from
    // the LPA process and emitting it over the event channel is unnecessary for
    // eSIM operation tracking and expands the identifier surface.
    /*
    private fun emitImeiIdentifier(factoryService: Any, operation: EsimOperationSnapshot) {
        try {
            val context = factoryService.javaClass.getMethod("getApplicationContext").invoke(factoryService) as? android.content.Context
                ?: return
            val telephonyManager = context.getSystemService("phone") as? TelephonyManager
            val imei = getCurrentImei(context, telephonyManager)
            if (!imei.isNullOrBlank()) {
                EsimEventEmitter.emitDeviceIdentifier(operation, DEVICE_IDENTIFIER_IMEI_KEY, imei)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "  Failed to emit IMEI identifier (${t.javaClass.simpleName})")
        }
    }

    // The hook executes inside the privileged LPA host and every platform call
    // remains guarded. Do not add READ_PRIVILEGED_PHONE_STATE to this /data/app
    // manifest: the Pin enforces the privapp allowlist and will boot-loop.
    @SuppressLint("MissingPermission")
    private fun getCurrentImei(context: android.content.Context, telephonyManager: TelephonyManager?): String? {
        if (telephonyManager == null) return null
        if (context.checkSelfPermission("android.permission.READ_PHONE_STATE") != PackageManager.PERMISSION_GRANTED) {
            return null
        }

        return try {
            val imei = if (Build.VERSION.SDK_INT >= 26) {
                val tmWrapperClass = context.classLoader?.loadClass("es.com.valid.lib_lpa.cardCommunication.TMWrapper")
                val slotIndex = tmWrapperClass?.getMethod("getSlotIndex")?.invoke(null) as? Int ?: -2
                if (slotIndex == -2) {
                    telephonyManager.imei
                } else {
                    telephonyManager.getImei(slotIndex)
                }
            } else {
                @Suppress("DEPRECATION")
                telephonyManager.deviceId
            }
            imei?.let {
                if (it.length % 2 == 1) "${it}F" else it
            }
        } catch (t: Throwable) {
            Log.w(TAG, "  Failed to read IMEI (${t.javaClass.simpleName})")
            null
        }
    }
    */

    private fun decodeProfileName(
        profileNameObject: Any?,
        getHexValueMethod: Method,
        hexToAsciiMethod: Method,
    ): String? {
        if (profileNameObject == null) return null
        return try {
            val hexValue = getHexValueMethod.invoke(profileNameObject) as? String ?: return null
            if (hexValue.isBlank()) return null
            (hexToAsciiMethod.invoke(null, hexValue) as? String)?.trim()
        } catch (t: Throwable) {
            Log.w(TAG, "  Failed to decode profile name (${t.javaClass.simpleName})")
            null
        }
    }

    internal fun deletionBlockReason(
        profileName: String?,
        profileState: String?,
    ): DeleteBlockReason? {
        if (isProtectedProfileName(profileName)) {
            return DeleteBlockReason.PROTECTED_PROFILE
        }
        return when (profileState?.trim()?.lowercase()) {
            "disabled" -> null
            "enabled", "active" -> DeleteBlockReason.ACTIVE_PROFILE
            else -> DeleteBlockReason.UNVERIFIED_PROFILE_STATE
        }
    }

    internal fun deleteRequestIdentityIsUsable(targetIccid: String?): Boolean =
        !targetIccid.isNullOrBlank()

    private fun isProtectedProfileName(profileName: String?): Boolean {
        val normalized = profileName?.trim()?.lowercase().orEmpty()
        if (normalized.isEmpty()) return false
        return normalized.startsWith(PROTECTED_T_MOBILE_NAME) || normalized.startsWith(PROTECTED_GSMA_TEST_PREFIX)
    }

    // DISABLED per R-006: carrier-lock bypass is a trust decision substitution.
    // Rewriting getProfileName() to "Humane" subverts the carrier lock check in
    // factoryService line 839 so the delete branch becomes unreachable for any
    // profile. This replaces a platform trust decision with a hook-side override,
    // which is the exact class of defect R-006 flags.
    /*
    private fun hookCarrierLock(cl: ClassLoader) {
        val factoryServiceClass = cl.loadClass(StockSymbols.EsimLpa.FACTORY_SERVICE_CLASS)
        val profileInfoClass = cl.loadClass("es.com.valid.lib_lpa.dataClasses.ProfileInfo")
        val hexStringClass = cl.loadClass("es.com.valid.lib_lpa.dataClasses.HexString")
        val setValueMethod = hexStringClass.getMethod("setValue", String::class.java)

        // Clear the bypass flag at the start of every new intent
        HookUtils.hookMethodBefore(
            factoryServiceClass,
            "onStartCommand",
            arrayOf(Intent::class.java, Int::class.javaPrimitiveType!!, Int::class.javaPrimitiveType!!)
        ) { _ ->
            if (bypassActive.getAndSet(false)) {
                Log.w(TAG, "  Carrier lock bypass: cleared stale flag on new intent")
            }
        }

        // Set the bypass flag when the download-verify-enable flow starts
        HookUtils.hookMethodBefore(
            factoryServiceClass,
            "downloadVerifyAndEnableProfileAPI",
            arrayOf(String::class.java)
        ) { _ ->
            bypassActive.set(true)
            Log.w(TAG, "  Carrier lock bypass: activated for downloadVerifyAndEnableProfile")
        }

        // Patch getProfileName() only when bypass is active
        HookUtils.hookMethodAfter(profileInfoClass, "getProfileName", emptyArray()) { param ->
            if (bypassActive.get()) {
                val hexString = param.result
                if (hexString != null) {
                    setValueMethod.invoke(hexString, HUMANE_HEX)
                    Log.w(TAG, "  Carrier lock bypass: getProfileName() -> \"Humane\"")
                }
            }
        }

        Log.w(TAG, "  Carrier lock bypass installed")
    }
    */

    /**
     * Replace FillerEngine.fillStoreMetadataRequest(String, int) with a version
     * that properly handles unknown TLV tags (including multi-byte tags like BF76)
     * by skipping them instead of infinite-looping.
     */
    private fun hookBF25Parser(cl: ClassLoader) {
        val fillerEngineClass = cl.loadClass("es.com.valid.lib_lpa.controler.FillerEngine")

        HookUtils.hookMethodBefore(
            fillerEngineClass,
            "fillStoreMetadataRequest",
            arrayOf(String::class.java, Int::class.javaPrimitiveType!!)
        ) { param ->
            val str = param.args[0] as String
            val i = param.args[1] as Int
            val fillerEngine = param.thisObject

            param.result = parseBF25(fillerEngine, str, i)
        }

        Log.w(TAG, "  BF25 parser fix installed (FillerEngine.fillStoreMetadataRequest)")
    }

    /**
     * Replacement algorithm for fillStoreMetadataRequest, with proper
     * multi-byte BER-TLV tag support.
     */
    private fun parseBF25(fillerEngine: Any, str: String, i: Int): Any {
        val smr = storeMetadataRequestClass.getDeclaredConstructor().newInstance()

        // Verify BF25 tag at offset
        val i4 = i + 4
        if (str.substring(i, i4).uppercase() != "BF25") {
            throw Exception("Invalid Tag for Profiles Metadata")
        }

        // Parse BF25 envelope
        val lengthBytes = getBERLengthInInt(str, i4)
        val lengthFieldSize = getBERLengthSizeInNibbles(str, i4)
        val dataStart = i4 + lengthFieldSize
        val dataEnd = dataStart + lengthBytes * 2

        Log.w(TAG, "  BF25 parser: length=$lengthBytes bytes, dataStart=$dataStart, dataEnd=$dataEnd")

        var offset = dataStart
        var iterations = 0

        while (offset < dataEnd && iterations < MAX_ITERATIONS) {
            iterations++

            if (offset + 2 > str.length) {
                Log.e(TAG, "  BF25 parser: offset $offset out of bounds (str.length=${str.length})")
                break
            }

            // Read first byte of tag
            val firstTagByte = str.substring(offset, offset + 2).uppercase()
            val firstByte = firstTagByte.toInt(16)

            // Check for multi-byte tag: low 5 bits of first byte all set
            val tag: String
            val tagNibbles: Int
            if ((firstByte and 0x1F) == 0x1F) {
                // Multi-byte tag (e.g., BF76)
                if (offset + 4 > str.length) {
                    Log.e(TAG, "  BF25 parser: not enough data for multi-byte tag at $offset")
                    break
                }
                tag = str.substring(offset, offset + 4).uppercase()
                tagNibbles = 4
            } else {
                tag = firstTagByte
                tagNibbles = 2
            }

            Log.w(TAG, "  BF25 parser: iteration=$iterations, offset=$offset, tag=$tag")

            var consumed = 0

            try {
                when (tag) {
                    "5A" -> { // ICCID
                        val obj = fillIccidMethod.invoke(fillerEngine, str, offset)
                        consumed = iccidGetSizeMethod.invoke(obj) as Int
                        smrSetIccid.invoke(smr, obj)
                    }
                    "91" -> { // ServiceProviderName
                        val obj = fillHexStringMethod.invoke(fillerEngine, str, offset)
                        consumed = hexStringGetSizeMethod.invoke(obj) as Int
                        smrSetServiceProviderName.invoke(smr, obj)
                    }
                    "92" -> { // ProfileName
                        val obj = fillHexStringMethod.invoke(fillerEngine, str, offset)
                        consumed = hexStringGetSizeMethod.invoke(obj) as Int
                        smrSetProfileName.invoke(smr, obj)
                    }
                    "93" -> { // IconType
                        val obj = fillIconTypeMethod.invoke(fillerEngine, str, offset)
                        consumed = iconTypeGetSizeMethod.invoke(obj) as Int
                        smrSetIconType.invoke(smr, obj)
                    }
                    "94" -> { // Icon — manual size (getSize reports inner data, not full TLV)
                        val obj = fillIconMethod.invoke(fillerEngine, str, offset) as ByteArray
                        val lenOffset = offset + 2
                        val lenBytes = getBERLengthInInt(str, lenOffset)
                        val lenFieldSize = getBERLengthSizeInNibbles(str, lenOffset)
                        consumed = 2 + lenFieldSize + lenBytes * 2
                        smrSetIcon.invoke(smr, obj)
                    }
                    "95" -> { // ProfileClass
                        val obj = fillProfileClassMethod.invoke(fillerEngine, str, offset)
                        consumed = profileClassGetSizeMethod.invoke(obj) as Int
                        smrSetProfileClass.invoke(smr, obj)
                    }
                    "99" -> { // ProfilePolicyRules
                        val obj = fillPprIdsMethod.invoke(fillerEngine, str, offset)
                        consumed = pprIdsGetSizeMethod.invoke(obj) as Int
                        smrSetProfilePolicyRules.invoke(smr, obj)
                    }
                    "B6" -> { // NotificationConfigurationInfo — manual size
                        val obj = fillNotificationConfigInfoMethod.invoke(fillerEngine, str, offset)
                        // obj is NotificationConfigurationInformation[]
                        val arr = obj as Array<*>
                        var innerBytes = 0
                        for (item in arr) {
                            if (item != null) {
                                innerBytes += (notifConfigGetSizeMethod.invoke(item) as Int) / 2
                            }
                        }
                        val berLenSize = getBERLengthSizeInNibbles(innerBytes)
                        consumed = 2 + berLenSize + innerBytes * 2
                        smrSetNotificationConfigInfo.invoke(smr, obj)
                    }
                    "B7" -> { // OperatorId
                        val obj = fillOperatorIdMethod.invoke(fillerEngine, str, offset)
                        consumed = operatorIdGetSizeMethod.invoke(obj) as Int
                        smrSetProfileOwner.invoke(smr, obj)
                    }
                    else -> {
                        // Unknown tag — skip it properly
                        val lengthOffset = offset + tagNibbles
                        val lenBytes = getBERLengthInInt(str, lengthOffset)
                        val lenFieldSize = getBERLengthSizeInNibbles(str, lengthOffset)
                        consumed = tagNibbles + lenFieldSize + lenBytes * 2
                        Log.w(TAG, "  BF25 parser: skipping unknown tag $tag, consumed=$consumed nibbles")
                    }
                }
            } catch (e: Throwable) {
                // On error, try to skip the tag
                Log.e(TAG, "  BF25 parser: error processing tag $tag at offset $offset (${e.javaClass.simpleName})")
                try {
                    val lengthOffset = offset + tagNibbles
                    val lenBytes = getBERLengthInInt(str, lengthOffset)
                    val lenFieldSize = getBERLengthSizeInNibbles(str, lengthOffset)
                    consumed = tagNibbles + lenFieldSize + lenBytes * 2
                    Log.w(TAG, "  BF25 parser: skipping errored tag $tag, consumed=$consumed nibbles")
                } catch (skipError: Throwable) {
                    Log.e(TAG, "  BF25 parser: cannot skip tag $tag after error, breaking (${skipError.javaClass.simpleName})")
                    break
                }
            }

            if (consumed > 0) {
                offset += consumed
            } else {
                Log.e(TAG, "  BF25 parser: tag $tag consumed 0 nibbles, breaking to prevent infinite loop")
                break
            }
        }

        if (iterations >= MAX_ITERATIONS) {
            Log.w(TAG, "  BF25 parser: max iterations ($MAX_ITERATIONS) reached")
        }

        Log.w(TAG, "  BF25 parser: completed, processed $iterations tags")
        return smr
    }

    private fun getBERLengthInInt(str: String, offset: Int): Int {
        return getBERLengthInIntMethod.invoke(null, str, offset) as Int
    }

    private fun getBERLengthSizeInNibbles(str: String, offset: Int): Int {
        return getBERLengthSizeStrMethod.invoke(null, str, offset) as Int
    }

    private fun getBERLengthSizeInNibbles(lengthInBytes: Int): Int {
        return getBERLengthSizeIntMethod.invoke(null, lengthInBytes) as Int
    }
}
