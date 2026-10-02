package com.penumbraos.hook

import android.database.ContentObserver
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
 * that existing UI flow. It neither replaces OPAQUE nor fabricates a DeviceUser
 * credential. The setting is deleted before the stock login attempt starts.
 */
internal object CosmosOnboardingAutomation {
    internal const val PINCODE_SETTING = "penumbra_cosmos_onboarding_pincode"
    private const val TAG = "LumaCompatibility"
    private const val PROMPT_ADVANCE_DELAY_MS = 300L
    private const val DUC_PROVISIONED_SETTING = "humane.settings.global.DUC_PROVISIONED"
    private val initialWifiDisableHandled = AtomicBoolean(false)
    private val pincodeObserverInstalled = AtomicBoolean(false)
    private val promptAdvanceScheduled = AtomicBoolean(false)
    @Volatile private var activeIntroNode: WeakReference<Any>? = null
    @Volatile private var activePromptNode: WeakReference<Any>? = null
    @Volatile private var activePincodeNode: WeakReference<Any>? = null

    fun install(classLoader: ClassLoader) {
        installInitialWifiGuard()
        val promptNode = classLoader.loadClass(
            "humane.experience.onboarding.node.PincodePromptNode",
        )
        val pincodeNode = classLoader.loadClass(
            "humane.experience.onboarding.node.PincodeNode",
        )
        HookUtils.hookMethodAfter(promptNode, "willBecomeActive", emptyArray()) { param ->
            val node = param.thisObject
            activePromptNode = WeakReference(node)
            ensurePendingPincodeObserver()
            schedulePromptAdvance(node)
        }

        HookUtils.hookMethodBefore(pincodeNode, "didBecomeActive", emptyArray()) { param ->
            val node = param.thisObject
            activePromptNode = null
            activePincodeNode = WeakReference(node)
            ensurePendingPincodeObserver()
            handoffPendingPincode(node, attemptImmediately = false)
        }
        runCatching { installSubscriptionBindRetry(classLoader) }.onFailure { error ->
            Log.e(
                TAG,
                "  Remote Cosmos subscription retry hook unavailable " +
                    "(${error.javaClass.simpleName})",
            )
        }
    }

    internal fun isCompatiblePincode(value: String?): Boolean =
        value?.length == 4 && value.all(Char::isDigit) && value.all { it.code in 0x30..0x39 }

    internal fun shouldPreserveInitialWifi(
        ducProvisioned: Boolean,
        requestedEnabled: Boolean,
        alreadyHandled: Boolean,
    ): Boolean = !ducProvisioned && !requestedEnabled && !alreadyHandled

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
                    ducProvisioned,
                    requestedEnabled,
                    initialWifiDisableHandled.get(),
                ) && initialWifiDisableHandled.compareAndSet(false, true)
            ) {
                // Stock OnboardingCoordinator's constructor turns Wi-Fi off for
                // the original cellular-first flow. This hook is package-scoped,
                // so its presence is the Luma gate: activation happens later and
                // a recovered Wi-Fi-only Pin must stay online long enough to reach it.
                param.result = true
                Log.w(TAG, "  Remote Cosmos preserved Wi-Fi for clone onboarding")
            }
        }
    }

    /**
     * Stock `PincodePromptNode.next()` advances into pincode entry. Stock
     * `PincodeNode.didBecomeActive()` consumes `mAdbPincode` and starts its normal
     * login. When Center stages the code after that callback, invoking the same
     * `PincodeNode.attemptUnlock()` method resumes the existing OPAQUE path.
     */
    private fun ensurePendingPincodeObserver() {
        if (pincodeObserverInstalled.get()) return
        val application = CosmosRemoteTransport.currentApplication() ?: return
        if (!pincodeObserverInstalled.compareAndSet(false, true)) return
        try {
            application.contentResolver.registerContentObserver(
                Settings.Global.getUriFor(PINCODE_SETTING),
                false,
                object : ContentObserver(Handler(Looper.getMainLooper())) {
                    override fun onChange(selfChange: Boolean) {
                        dispatchPendingPincode()
                    }
                },
            )
        } catch (error: Throwable) {
            pincodeObserverInstalled.set(false)
            Log.e(
                TAG,
                "  Remote Cosmos pincode observer failed (${error.javaClass.simpleName})",
            )
        }
    }

    private fun dispatchPendingPincode() {
        if (!CosmosRemoteTransport.isEnabled()) return
        val pincodeNode = activePincodeNode?.get()
        if (pincodeNode != null && handoffPendingPincode(pincodeNode, attemptImmediately = true)) {
            return
        }
        activePromptNode?.get()?.let(::schedulePromptAdvance)
    }

    private fun schedulePromptAdvance(node: Any) {
        if (!CosmosRemoteTransport.isEnabled() || pendingPincode() == null) return
        if (!promptAdvanceScheduled.compareAndSet(false, true)) return
        Handler(Looper.getMainLooper()).postDelayed({
            try {
                if (activePromptNode?.get() !== node ||
                    !CosmosRemoteTransport.isEnabled() ||
                    pendingPincode() == null
                ) {
                    return@postDelayed
                }
                node.javaClass.getMethod("next").invoke(node)
                Log.w(TAG, "  Remote Cosmos onboarding advanced to stock pincode entry")
            } catch (error: Throwable) {
                Log.e(
                    TAG,
                    "  Remote Cosmos onboarding could not advance (${error.javaClass.simpleName})",
                )
            } finally {
                promptAdvanceScheduled.set(false)
            }
        }, PROMPT_ADVANCE_DELAY_MS)
    }

    private fun handoffPendingPincode(node: Any, attemptImmediately: Boolean): Boolean {
        if (!CosmosRemoteTransport.isEnabled()) return false
        val field = try {
            node.javaClass.getDeclaredField("mAdbPincode").apply { isAccessible = true }
        } catch (error: Throwable) {
            Log.e(TAG, "  Remote Cosmos pincode field unavailable (${error.javaClass.simpleName})")
            return false
        }
        val pincode = claimPendingPincode() ?: return false
        return try {
            field.set(node, pincode)
            if (attemptImmediately) {
                node.javaClass.getDeclaredMethod("attemptUnlock").apply {
                    isAccessible = true
                    invoke(node)
                }
            }
            Log.w(TAG, "  Remote Cosmos pincode handed to the stock OPAQUE login")
            true
        } catch (error: Throwable) {
            Log.e(TAG, "  Remote Cosmos pincode handoff failed (${error.javaClass.simpleName})")
            false
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
        resolver.delete(Settings.Global.getUriFor(PINCODE_SETTING), null, null)
        if (Settings.Global.getString(resolver, PINCODE_SETTING) != null) {
            Log.e(TAG, "  Remote Cosmos pincode could not be removed; refusing automatic entry")
            return null
        }
        return pincode
    }
}
