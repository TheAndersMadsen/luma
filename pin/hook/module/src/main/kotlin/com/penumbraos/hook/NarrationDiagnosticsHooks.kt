package com.penumbraos.hook

import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.util.UUID

/**
 * Content-free diagnostics for the stock narration decision chain.
 *
 * The installed Ironman build strips Timber D/I logs, so every veto between an
 * experience's `requestNarration` and the first audible synthesis is invisible:
 * `Arbitrator.registerAiMicEvent` (active-run gate), the AiMic observer's
 * narration case, `Arbitrator.isNarrationAllowed` (laser + active-run gates),
 * and `NarratorImpl` queue processing all decline silently. These after-hooks
 * re-log only run-scoped identifiers, booleans, enum names, and text lengths at
 * W level. Narration text itself is never logged.
 *
 * Observation-only: no hook writes a parameter, result, or field.
 */
object NarrationDiagnosticsHooks {
    private const val TAG = "PenumbraNarration"

    private const val AI_ACCESS_CLASS =
        "humaneinternal.system.coordination.impl.ExperienceAiAccessImpl"
    private const val ARBITRATOR_CLASS = "humaneinternal.system.tao.Arbitrator"
    private const val RUN_MANAGER_CLASS = "humaneinternal.system.intent.RunManager"
    private const val EVENTS_SNAPSHOT_CLASS = "humaneinternal.system.intent.EventsSnapshot"
    private const val NARRATOR_CLASS = "humaneinternal.system.narrator.NarratorImpl"
    private const val NARRATOR_REQUEST_CLASS = "humaneinternal.system.narrator.NarratorRequest"
    private const val AI_MIC_EVENT_CLASS = "humaneinternal.system.intent.AiMicEvent"
    private const val COMPLETION_HANDLER_CLASS =
        "humaneinternal.system.narrator.Narrator\$NarratorCompletionHandler"

    fun install(cl: ClassLoader) {
        val narratorRequest = loadOrNull(cl, NARRATOR_REQUEST_CLASS) ?: return
        val requestIdentifier = accessorOrNull(narratorRequest, "identifier")
        val requestText = accessorOrNull(narratorRequest, "text")

        fun describeRequest(request: Any?): String {
            if (request == null || !narratorRequest.isInstance(request)) return "request=invalid"
            val id = runCatching { requestIdentifier?.invoke(request) }.getOrNull()
            val textLength = runCatching {
                (requestText?.invoke(request) as? String)?.length
            }.getOrNull()
            return "id=$id textLen=$textLength"
        }

        hookAiAccess(cl, narratorRequest, ::describeRequest)
        hookArbitrator(cl, narratorRequest, ::describeRequest)
        hookRunManager(cl)
        hookNarrator(cl, narratorRequest, ::describeRequest)
        Log.w(TAG, "Narration diagnostics installed")
    }

    private fun hookAiAccess(
        cl: ClassLoader,
        narratorRequest: Class<*>,
        describeRequest: (Any?) -> String,
    ) {
        val aiAccess = loadOrNull(cl, AI_ACCESS_CLASS) ?: return
        hookAfter(aiAccess, "requestNarration", arrayOf(narratorRequest)) { param ->
            Log.w(TAG, "requestNarration ${describeRequest(param.args.getOrNull(0))}")
        }
    }

    private fun hookArbitrator(
        cl: ClassLoader,
        narratorRequest: Class<*>,
        describeRequest: (Any?) -> String,
    ) {
        val arbitrator = loadOrNull(cl, ARBITRATOR_CLASS) ?: return
        val aiMicEvent = loadOrNull(cl, AI_MIC_EVENT_CLASS)
        val eventIdentifier = aiMicEvent?.let { accessorOrNull(it, "identifier") }
        val eventType = aiMicEvent?.let { accessorOrNull(it, "aiMicEventType") }
        val laserField = runCatching {
            arbitrator.getDeclaredField("mIsLaserDisplayShowing").apply { isAccessible = true }
        }.getOrNull()

        if (aiMicEvent != null) {
            hookAfter(arbitrator, "registerAiMicEvent", arrayOf(aiMicEvent)) { param ->
                val event = param.args.getOrNull(0) ?: return@hookAfter
                val id = runCatching { eventIdentifier?.invoke(event) }.getOrNull()
                val type = runCatching { eventType?.invoke(event)?.toString() }.getOrNull()
                Log.w(TAG, "registerAiMicEvent type=$type id=$id")
            }
        }

        hookAfter(arbitrator, "isNarrationAllowed", arrayOf(UUID::class.java)) { param ->
            val laser = runCatching { laserField?.get(param.thisObject) }.getOrNull()
            Log.w(
                TAG,
                "isNarrationAllowed id=${param.args.getOrNull(0)} " +
                    "result=${param.result} laser=$laser",
            )
        }

        hookAfter(
            arbitrator,
            "eventForRequestNarration",
            arrayOf(narratorRequest, java.time.Instant::class.java),
        ) { param ->
            Log.w(TAG, "eventForRequestNarration ${describeRequest(param.args.getOrNull(0))}")
        }
    }

    private fun hookRunManager(cl: ClassLoader) {
        val runManager = loadOrNull(cl, RUN_MANAGER_CLASS) ?: return

        hookAfter(runManager, "isInActiveRun", arrayOf(String::class.java)) { param ->
            Log.w(
                TAG,
                "isInActiveRun id=${param.args.getOrNull(0)} result=${param.result}",
            )
        }

        val eventsSnapshot = loadOrNull(cl, EVENTS_SNAPSHOT_CLASS) ?: return
        val getCurrent = accessorOrNull(eventsSnapshot, "getCurrent")
        hookAfter(runManager, "shouldDispatchCurrent", arrayOf(eventsSnapshot)) { param ->
            val candidateId = runCatching {
                val current = getCurrent?.invoke(param.args.getOrNull(0))
                current?.javaClass?.getMethod("getIdentifier")?.invoke(current)
            }.getOrNull()
            Log.w(
                TAG,
                "shouldDispatchCurrent candidate=$candidateId result=${param.result}",
            )
        }
    }

    private fun hookNarrator(
        cl: ClassLoader,
        narratorRequest: Class<*>,
        describeRequest: (Any?) -> String,
    ) {
        val narrator = loadOrNull(cl, NARRATOR_CLASS) ?: return

        hookAfter(narrator, "enqueueNarration", arrayOf(narratorRequest)) { param ->
            Log.w(TAG, "enqueueNarration ${describeRequest(param.args.getOrNull(0))}")
        }

        val completionHandler = loadOrNull(cl, COMPLETION_HANDLER_CLASS) ?: return
        hookAfter(
            narrator,
            "tellUserIn",
            arrayOf(
                String::class.java,
                java.util.Locale::class.java,
                UUID::class.java,
                String::class.java,
                completionHandler,
                Boolean::class.javaPrimitiveType!!,
                Boolean::class.javaPrimitiveType!!,
            ),
        ) { param ->
            Log.w(TAG, "tellUserIn id=${param.args.getOrNull(2)}")
        }
    }

    private fun loadOrNull(cl: ClassLoader, name: String): Class<*>? = try {
        cl.loadClass(name)
    } catch (t: Throwable) {
        Log.w(TAG, "$name unavailable: ${t.javaClass.simpleName}")
        null
    }

    /** Zero-argument accessor used only to read run-scoped metadata. */
    private fun accessorOrNull(clazz: Class<*>, name: String) = runCatching {
        clazz.getMethod(name).apply { isAccessible = true }
    }.getOrNull()

    private fun hookAfter(
        clazz: Class<*>,
        methodName: String,
        parameterTypes: Array<Class<*>?>,
        onAfter: (XC_MethodHook.MethodHookParam) -> Unit,
    ) {
        try {
            val method = clazz.getDeclaredMethod(
                methodName,
                *parameterTypes.map { requireNotNull(it) }.toTypedArray(),
            ).apply { isAccessible = true }
            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    // Diagnostics must never alter stock behavior, even on error.
                    runCatching { onAfter(param) }
                }
            })
            Log.w(TAG, "  Hooked ${clazz.simpleName}.$methodName")
        } catch (t: Throwable) {
            Log.w(TAG, "  ${clazz.simpleName}.$methodName hook unavailable: ${t.javaClass.simpleName}")
        }
    }
}
