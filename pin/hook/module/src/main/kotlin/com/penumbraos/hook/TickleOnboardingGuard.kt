package com.penumbraos.hook

import android.app.Activity
import android.content.Intent
import android.os.Message
import android.provider.Settings
import android.util.Log
import com.penumbraos.stockaibus.contract.StockSymbols
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.util.WeakHashMap
import java.lang.ref.WeakReference

/**
 * INFERRED: Tickle must not interrupt stock onboarding. Stock
 * humane.experience.onboarding.node.WelcomeNode.launchHome writes
 * DUC_PROVISIONED=1 before OnboardingCoordinator.finishOnboarding disables
 * OnboardingHome. OnboardingCoordinator.configureAdbTestOnlySettings is the
 * stock test-only alternative that writes the same setting.
 * Keep an instance rejected during onboarding rejected until Android destroys it;
 * completing onboarding permits a fresh launch, never replays the old intent.
 */
internal class TickleOnboardingGate {
    private val rejected = WeakHashMap<Any, Boolean>()
    private val owners = WeakHashMap<Any, WeakReference<Any>>()

    @Synchronized
    fun bind(instance: Any, experience: Any, packageName: String) {
        if (packageName == StockSymbols.Tickle.PACKAGE) {
            owners[experience] = WeakReference(instance)
        }
    }

    @Synchronized
    fun allowInbound(
        experience: Any,
        readProvisioned: (Any) -> Int?,
        reject: (Any) -> Unit,
    ): Boolean {
        // Unbound stock experiences keep their original behavior. A queued
        // callback whose bound Activity has disappeared cannot safely initialize
        // the abandoned experience. Weak values avoid an Activity retention cycle.
        val reference = owners[experience] ?: return true
        val owner = reference.get() ?: return false
        return allow(owner, StockSymbols.Tickle.PACKAGE, { readProvisioned(owner) }, { reject(owner) })
    }

    @Synchronized
    fun allow(
        instance: Any,
        packageName: String,
        readProvisioned: () -> Int?,
        reject: () -> Unit,
    ): Boolean {
        if (packageName != StockSymbols.Tickle.PACKAGE) return true
        val complete = rejected[instance] != true && try {
            readProvisioned() == 1
        } catch (_: Exception) {
            false
        }
        if (complete) return true
        rejected[instance] = true
        reject()
        return false
    }
}

/**
 * Stock humaneinternal.system.ipc.HumaneExperienceActivity.onCreate calls
 * initializeExperienceUI and handleIntent, and its IPC connection callback later
 * calls initializeExperienceUI/callExperienceActionHandler and consumes the three
 * pending fields. The incoming callback captures createExperience's result
 * before UI initialization and calls ExperiencePrivate.onReceiveMessage, whose
 * appContext/messengers require initialization. Bind the result before callback
 * registration and suppress queued messages for rejected/abandoned instances.
 * onNewIntent calls handleIntent again. Guard these boundaries,
 * not onCreate: Android/AppCompat lifecycle supers must always run normally.
 * Stock onResume/onPause tolerate null mExperience. OnStop/onDestroy call supers.
 */
object TickleOnboardingGuard {
    private const val TAG = "LumaCompatibility"
    private const val DUC_PROVISIONED = "humane.settings.global.DUC_PROVISIONED"
    private val gate = TickleOnboardingGate()
    private var installed = false

    @Synchronized
    fun install(classLoader: ClassLoader) {
        if (installed) return
        val registrations = mutableListOf<XC_MethodHook.Unhook>()
        try {
            val activityClass = classLoader.loadClass(
                StockSymbols.ExperienceRuntime.HUMANE_EXPERIENCE_ACTIVITY,
            )
            val experienceClass = classLoader.loadClass("humane.experience.Experience")
            val actionClass = classLoader.loadClass("humaneinternal.system.intent.actions.Action")
            val privateClass = classLoader.loadClass("humane.experience.ExperiencePrivate")
            val create = activityClass.getDeclaredMethod("createExperience")
            val receive = privateClass.getDeclaredMethod("onReceiveMessage", Message::class.java)
            require(create.returnType == experienceClass && receive.returnType == Boolean::class.javaPrimitiveType)
            val pending = listOf("mActionToHandle", "mDataToHandle", "mCustomLaunchIntent")
                .map { name -> activityClass.getDeclaredField(name).apply { isAccessible = true } }
            val methods = listOf(
                activityClass.getDeclaredMethod("initializeExperienceUI", experienceClass),
                activityClass.getDeclaredMethod("handleIntent", Intent::class.java),
                activityClass.getDeclaredMethod("callExperienceActionHandler", actionClass),
            )
            fun readProvisioned(activity: Activity): Int =
                Settings.Global.getInt(activity.contentResolver, DUC_PROVISIONED, 0)

            fun reject(activity: Activity) {
                // Clear before finishing: an already queued IPC callback can
                // run after finish, including after DUC changes to1.
                pending.forEach { field -> field.set(activity, null) }
                activity.finish()
            }

            fun allowed(activity: Activity): Boolean = gate.allow(
                activity, activity.packageName, { readProvisioned(activity) }, { reject(activity) },
            )

            val callback = object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val activity = param.thisObject as? Activity ?: return
                    if (!allowed(activity)) param.result = null
                }
            }
            create.isAccessible = true
            registrations += XposedBridge.hookMethod(create, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    val activity = param.thisObject as? Activity ?: return
                    val experience = param.result ?: return
                    gate.bind(activity, experience, activity.packageName)
                    // Latch before stock registers incoming messages or any
                    // delayed UI/IPC callback can observe a later DUC value.
                    allowed(activity)
                }
            })
            receive.isAccessible = true
            registrations += XposedBridge.hookMethod(receive, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    if (!gate.allowInbound(
                            param.thisObject,
                            { owner -> readProvisioned(owner as Activity) },
                            { owner -> reject(owner as Activity) },
                        )) {
                        param.result = true
                    }
                }
            })
            for (method in methods) {
                method.isAccessible = true
                registrations += XposedBridge.hookMethod(method, callback)
            }
            installed = true
            Log.w(TAG, "  Tickle onboarding guard installed")
        } catch (error: Throwable) {
            // A partial install must not turn a later retry into duplicate hooks.
            registrations.forEach { registration -> registration.unhook() }
            Log.e(TAG, "  Tickle onboarding guard unavailable (${error.javaClass.simpleName})")
        }
    }
}
