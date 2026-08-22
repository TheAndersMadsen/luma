package com.penumbraos.hook

import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicBoolean

/**
 * One-shot USB-assisted entry of the clone-owned onboarding pincode.
 *
 * The stock onboarding app accepts exactly four digits and performs the real
 * OPAQUE ceremony itself. This hook only bridges an operator-staged value into
 * that existing UI flow; it neither replaces OPAQUE nor fabricates a DeviceUser
 * credential. The setting is deleted before the stock login attempt starts.
 */
internal object CosmosOnboardingAutomation {
    internal const val PINCODE_SETTING = "penumbra_carry_onboarding_pincode"
    private const val TAG = "PenumbraHook"
    private const val PROMPT_ADVANCE_DELAY_MS = 300L
    private const val DUC_PROVISIONED_SETTING = "humane.settings.global.DUC_PROVISIONED"
    private val initialWifiDisableHandled = AtomicBoolean(false)
    @Volatile private var activeIntroNode: WeakReference<Any>? = null

    fun install(classLoader: ClassLoader) {
        installInitialWifiGuard()
        val promptNode = classLoader.loadClass(
            "humane.experience.onboarding.node.PincodePromptNode",
        )
        val pincodeNode = classLoader.loadClass(
            "humane.experience.onboarding.node.PincodeNode",
        )
        installSubscriptionBindRetry(classLoader)

        HookUtils.hookMethodAfter(promptNode, "willBecomeActive", emptyArray()) { param ->
            if (!CosmosRemoteTransport.isEnabled() || pendingPincode() == null) {
                return@hookMethodAfter
            }
            val node = param.thisObject
            Handler(Looper.getMainLooper()).postDelayed({
                if (!CosmosRemoteTransport.isEnabled() || pendingPincode() == null) {
                    return@postDelayed
                }
                runCatching {
                    node.javaClass.getMethod("next").invoke(node)
                }.onSuccess {
                    Log.w(TAG, "  Remote Cosmos onboarding advanced to stock pincode entry")
                }.onFailure { error ->
                    Log.e(
                        TAG,
                        "  Remote Cosmos onboarding could not advance (${error.javaClass.simpleName})",
                    )
                }
            }, PROMPT_ADVANCE_DELAY_MS)
        }

        HookUtils.hookMethodBefore(pincodeNode, "didBecomeActive", emptyArray()) { param ->
            if (!CosmosRemoteTransport.isEnabled()) return@hookMethodBefore
            val pincode = claimPendingPincode() ?: return@hookMethodBefore
            try {
                param.thisObject.javaClass.getDeclaredField("mAdbPincode").apply {
                    isAccessible = true
                    set(param.thisObject, pincode)
                }
                Log.w(TAG, "  Remote Cosmos pincode handed to the stock OPAQUE login")
            } catch (error: Throwable) {
                Log.e(
                    TAG,
                    "  Remote Cosmos pincode handoff failed (${error.javaClass.simpleName})",
                )
            }
        }
    }

    internal fun isCompatiblePincode(value: String?): Boolean =
        value?.length == 4 && value.all(Char::isDigit) && value.all { it.code in 0x30..0x39 }

    internal fun shouldPreserveInitialWifi(
        cloneEnabled: Boolean,
        ducProvisioned: Boolean,
        requestedEnabled: Boolean,
        alreadyHandled: Boolean,
    ): Boolean = cloneEnabled && !ducProvisioned && !requestedEnabled && !alreadyHandled

    private fun installInitialWifiGuard() {
        HookUtils.hookMethodBefore(
            WifiManager::class.java,
            "setWifiEnabled",
            arrayOf(Boolean::class.javaPrimitiveType!!),
        ) { param ->
            val requestedEnabled = param.args.getOrNull(0) as? Boolean ?: return@hookMethodBefore
            val application = CosmosRemoteTransport.currentApplication() ?: return@hookMethodBefore
            val ducProvisioned = Settings.Global.getInt(
                application.contentResolver,
                DUC_PROVISIONED_SETTING,
                0,
            ) == 1
            if (
                shouldPreserveInitialWifi(
                    CosmosRemoteTransport.isEnabled(),
                    ducProvisioned,
                    requestedEnabled,
                    initialWifiDisableHandled.get(),
                ) && initialWifiDisableHandled.compareAndSet(false, true)
            ) {
                // OnboardingCoordinator's constructor turns Wi-Fi off for the
                // original cellular-first flow. A recovered Wi-Fi-only Pin
                // must remain online long enough to reach clone provisioning.
                param.result = true
                Log.w(TAG, "  Remote Cosmos preserved Wi-Fi for clone onboarding")
            }
        }
    }

    private fun installSubscriptionBindRetry(classLoader: ClassLoader) {
        val introNode = classLoader.loadClass(
            "humane.experience.onboarding.node.IntroNode",
        )
        val provisioningAccessManager = classLoader.loadClass(
            "humane.experience.onboarding.ProvisioningAccessManager",
        )
        val provisioningService = classLoader.loadClass(
            "humane.provisioning.IProvisioningService",
        )
        val subscriptionHelper = classLoader.loadClass(
            "humane.experience.onboarding.util.SubscriptionCheckHelper",
        )
        val subscriptionCallback = classLoader.loadClass(
            "humane.experience.onboarding.util.SubscriptionCheckHelper\$Callback",
        )
        val sharedInstance = subscriptionHelper.getMethod("getInstance")
        val checkSubscription = subscriptionHelper.getMethod(
            "checkSubscription",
            subscriptionCallback,
        )

        HookUtils.hookMethodAfter(introNode, "didBecomeActive", emptyArray()) { param ->
            if (CosmosRemoteTransport.isEnabled()) {
                activeIntroNode = WeakReference(param.thisObject)
            }
        }
        HookUtils.hookMethodBefore(introNode, "didResignActive", emptyArray()) { param ->
            if (activeIntroNode?.get() === param.thisObject) {
                activeIntroNode = null
            }
        }
        HookUtils.hookMethodAfter(
            provisioningAccessManager,
            "setProvisioningService",
            arrayOf(provisioningService),
        ) { param ->
            if (!CosmosRemoteTransport.isEnabled()) return@hookMethodAfter
            val node = activeIntroNode?.get() ?: return@hookMethodAfter
            runCatching {
                checkSubscription.invoke(sharedInstance.invoke(null), node)
            }.onSuccess {
                Log.w(TAG, "  Remote Cosmos retried subscription after service bind")
            }.onFailure { error ->
                Log.e(
                    TAG,
                    "  Remote Cosmos subscription bind retry failed " +
                        "(${error.javaClass.simpleName})",
                )
            }
        }
    }

    private fun pendingPincode(): String? {
        val application = CosmosRemoteTransport.currentApplication() ?: return null
        return Settings.Global.getString(application.contentResolver, PINCODE_SETTING)
            ?.takeIf(::isCompatiblePincode)
    }

    private fun claimPendingPincode(): String? {
        val application = CosmosRemoteTransport.currentApplication() ?: return null
        val resolver = application.contentResolver
        val pincode = Settings.Global.getString(resolver, PINCODE_SETTING)
            ?.takeIf(::isCompatiblePincode)
            ?: return null
        if (!Settings.Global.putString(resolver, PINCODE_SETTING, null)) {
            Log.e(TAG, "  Remote Cosmos pincode could not be removed; refusing automatic entry")
            return null
        }
        return pincode
    }
}
