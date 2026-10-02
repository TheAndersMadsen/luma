package com.penumbraos.hook

import android.util.Log
import com.penumbraos.stockaibus.contract.TierASymbols
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.lang.reflect.Method
import java.lang.reflect.Modifier
import java.util.Collections
import java.util.IdentityHashMap
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

/**
 * Prevents a malformed parent-linked chat history from exhausting Ironman's heap.
 *
 * Stock [humaneinternal.system.intent.EventsSnapshot] walks each turn's parent chain
 * until the parent is absent. The walk has no cycle detection. One cyclic retained
 * run therefore grows an ArrayList forever before any interpreter or gRPC request can
 * run. Keep stock's exact implementation for healthy chains. Only replace the helper
 * result when a repeated turn or an impossible chain depth is detected.
 */
object ContextHistorySafetyHooks {
    private const val TAG = "LumaCompatibility"
    private const val MAX_CHAIN_DEPTH = 512
    private const val PARENT_CHAIN_METHOD = "runFromHead"
    private const val RETAINED_SESSION_SECONDS = Int.MAX_VALUE
    private const val CLEAR_UNDERSTANDING_CONTEXT =
        TierASymbols.NativeActions.CLEAR_UNDERSTANDING_CONTEXT
    private const val SYNAPSE_DEVICE_SOURCE_VALUE = 0
    private const val SYNAPSE_SERVER_SOURCE_VALUE = 1
    private const val EXACT_RESET_MARKER =
        TierASymbols.OperationalMarkers.EXACT_CONTEXT_RESET_AUTHORIZED
    private const val PHYSICAL_ACTION_MARKER =
        TierASymbols.OperationalMarkers.NATIVE_ACTION_FOR_PHYSICAL_VERIFICATION

    private val physicalVerificationActions = setOf(
        TierASymbols.NativeActions.GET_CURRENT_TIME,
        TierASymbols.NativeActions.GET_BATTERY_LEVEL,
        TierASymbols.NativeActions.GET_CURRENT_LOCATION,
        TierASymbols.NativeActions.WORLD_CLOCK,
        TierASymbols.NativeActions.PLAY_MUSIC,
        TierASymbols.NativeActions.TICKLE,
    )

    private val truncatedChains = AtomicLong(0)

    internal data class ParentChain<T : Any>(
        val values: List<T>,
        val truncated: Boolean,
    )

    fun install(classLoader: ClassLoader) {
        try {
            val snapshotClass = classLoader.loadClass(
                "humaneinternal.system.intent.EventsSnapshot",
            )
            val turnClass = classLoader.loadClass("humane.aibus.SynapseChatTurn")
            val immutableListClass = classLoader.loadClass(
                "com.google.common.collect.ImmutableList",
            )
            val chainMethod = findParentChainMethod(
                snapshotClass = snapshotClass,
                turnClass = turnClass,
                immutableListClass = immutableListClass,
            ) ?: error("EventsSnapshot.runFromHead exact signature not found")
            val historyField = snapshotClass.getDeclaredField("mHistory").apply {
                isAccessible = true
            }
            val identifier = turnClass.getMethod("getIdentifier")
            val parentIdentifier = turnClass.getMethod("getParentIdentifier")
            val immutableCopyOf = immutableListClass.getMethod(
                "copyOf",
                Collection::class.java,
            )

            chainMethod.isAccessible = true
            XposedBridge.hookMethod(chainMethod, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val head = param.args.getOrNull(0) ?: return
                    try {
                        val history = historyField.get(param.thisObject) as? Map<*, *> ?: return
                        val chain = inspectParentChain(
                            head = head,
                            historySize = history.size,
                            identifierOf = { turn -> identifier.invoke(turn) as? String ?: "" },
                            parentOf = { turn ->
                                val parent = parentIdentifier.invoke(turn) as? String
                                if (parent.isNullOrEmpty()) null else history[parent]
                            },
                        )
                        if (!chain.truncated) return

                        // A singleton is deliberately incomplete when its parent is
                        // non-empty, so stock excludes a poisoned old run while the
                        // current healthy request continues normally.
                        param.result = immutableCopyOf.invoke(null, chain.values)
                        logTruncation(history.size)
                    } catch (error: Throwable) {
                        // Reflection succeeded at install time. If a malformed runtime
                        // object still defeats inspection, prefer a bounded singleton to
                        // stock's unbounded walk.
                        param.result = immutableCopyOf.invoke(null, listOf(head))
                        Log.e(
                            TAG,
                            "Context history inspection failed; bounded to one turn: " +
                                error.javaClass.simpleName,
                        )
                    }
                }
            })
            installLegacyPhysicalActionVerification(classLoader, turnClass)
            installLocalIntermediateRepair(classLoader, turnClass)
            installStockSessionRetention(classLoader)
            Log.w(TAG, "  ContextHistorySafetyHooks installed")
        } catch (error: Throwable) {
            Log.e(
                TAG,
                "ContextHistorySafetyHooks install failed: " +
                    "${error.javaClass.simpleName}: ${error.message}",
            )
        }
    }

    /**
     * Legacy local interpretation dispatches the final action directly through
     * TaoEventRegistrar.onContent rather than producing an IntermediateEvent.
     * Emit the same content-free physical-verification marker on both stock
     * paths so the harness observes what the device actually dispatched.
     */
    private fun installLegacyPhysicalActionVerification(
        classLoader: ClassLoader,
        turnClass: Class<*>,
    ) {
        try {
            val registrarClass = classLoader.loadClass(
                "humaneinternal.system.tao.TaoEventRegistrar",
            )
            val actionContentClass = classLoader.loadClass("humane.aibus.SynapseActionContent")
            val method = registrarClass.getDeclaredMethod(
                "onContent",
                actionContentClass,
                turnClass,
            ).apply { isAccessible = true }
            val getActionName = actionContentClass.getMethod("getAction")

            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    try {
                        val content = param.args.getOrNull(0) ?: return
                        physicalVerificationActionName(
                            hasAction = true,
                            actionName = getActionName.invoke(content) as? String,
                        )?.let { verifiedAction ->
                            Log.w(TAG, "$PHYSICAL_ACTION_MARKER | action=$verifiedAction")
                        }
                    } catch (error: Throwable) {
                        Log.e(
                            TAG,
                            "Legacy physical-action verification failed: " +
                                error.javaClass.simpleName,
                        )
                    }
                }
            })
            Log.w(TAG, "  Legacy physical-action verification installed")
        } catch (error: Throwable) {
            Log.e(
                TAG,
                "Legacy physical-action verification install failed: " +
                    "${error.javaClass.simpleName}: ${error.message}",
            )
        }
    }

    /**
     * Stock filters completed runs after 180 seconds even though the bounded
     * LocalChatTurnService still owns them. Keep recent completed turns eligible
     * until the user invokes ClearUnderstandingContext. Capacity pruning,
     * process lifecycle, and stock's keyguard privacy clear remain untouched.
     */
    private fun installStockSessionRetention(classLoader: ClassLoader) {
        try {
            val serviceClass = classLoader.loadClass(
                "humaneinternal.system.intent.LocalChatTurnService",
            )
            val retentionField = serviceClass.getDeclaredField(
                "mMaxSecondsBetweenRuns",
            ).apply { isAccessible = true }
            XposedBridge.hookAllConstructors(serviceClass, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val parameterTypes = (param.method as? java.lang.reflect.Constructor<*>)
                        ?.parameterTypes
                        ?: return
                    sessionRetentionArgumentIndex(parameterTypes)?.let { index ->
                        param.args[index] = RETAINED_SESSION_SECONDS
                    }
                }

                override fun afterHookedMethod(param: MethodHookParam) {
                    try {
                        retentionField.setInt(param.thisObject, RETAINED_SESSION_SECONDS)
                    } catch (error: Throwable) {
                        Log.e(
                            TAG,
                            "Stock session retention update failed: " +
                                error.javaClass.simpleName,
                        )
                    }
                }
            })
            Log.w(TAG, "  Stock contextual session retention installed")
        } catch (error: Throwable) {
            Log.e(
                TAG,
                "Stock session retention install failed: " +
                    "${error.javaClass.simpleName}: ${error.message}",
            )
        }
    }

    /**
     * Streaming mode routes local interpreter results through onIntermediateEvent.
     * Unlike real server events, those stock-local events have no identifier and
     * leave requires_response false. Stock then records (rather than dispatches)
     * the action under the empty-string map key. Since every root turn also has an
     * empty parent identifier, that single entry creates the parent cycle guarded
     * above. Restore the legacy single-action behavior only for DEVICE actions with
     * that exact shape. Proto3 scalar presence is unavailable, so schema value zero
     * is the positive DEVICE signal rather than an absent/unknown value.
     */
    private fun installLocalIntermediateRepair(
        classLoader: ClassLoader,
        turnClass: Class<*>,
    ) {
        try {
            val registrarClass = classLoader.loadClass(
                "humaneinternal.system.tao.TaoEventRegistrar",
            )
            val intermediateClass = classLoader.loadClass("humane.aibus.IntermediateEvent")
            val method = registrarClass.getDeclaredMethod(
                "onIntermediateEvent",
                intermediateClass,
                turnClass,
            ).apply { isAccessible = true }
            val getEvent = intermediateClass.getMethod("getEvent")
            val getRequiresResponse = intermediateClass.getMethod("getRequiresResponse")
            val intermediateCopyBuilder = findGeneratedCopyBuilderMethod(intermediateClass)
                ?: error("IntermediateEvent.newBuilder(IntermediateEvent) not found")
            val intermediateBuilderClass = intermediateCopyBuilder.returnType
            val setEvent = intermediateBuilderClass.getMethod("setEvent", turnClass)
            val setRequiresResponse = intermediateBuilderClass.getMethod(
                "setRequiresResponse",
                Boolean::class.javaPrimitiveType,
            )
            val buildIntermediate = intermediateBuilderClass.getMethod("build")
            val hasAction = turnClass.getMethod("hasAction")
            val getAction = turnClass.getMethod("getAction")
            val getActionName = getAction.returnType.getMethod("getAction")
            val getActionSourceValue = getAction.returnType.getMethod("getSourceValue")
            val hasUserRequest = turnClass.getMethod("hasUserRequest")
            val getUserRequest = turnClass.getMethod("getUserRequest")
            val getRequest = getUserRequest.returnType.getMethod("getRequest")
            val getIdentifier = turnClass.getMethod("getIdentifier")
            val turnCopyBuilder = findGeneratedCopyBuilderMethod(turnClass)
                ?: error("SynapseChatTurn.newBuilder(SynapseChatTurn) not found")
            val turnBuilderClass = turnCopyBuilder.returnType
            val setIdentifier = turnBuilderClass.getMethod("setIdentifier", String::class.java)
            val buildTurn = turnBuilderClass.getMethod("build")

            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    var localClearCandidate = false
                    try {
                        val intermediate = param.args.getOrNull(0) ?: return
                        val turn = getEvent.invoke(intermediate) ?: return
                        val actionPresent = hasAction.invoke(turn) as? Boolean ?: false
                        val action = if (actionPresent) {
                            runCatching { getAction.invoke(turn) }.getOrNull()
                        } else null
                        val actionName = if (actionPresent) {
                            runCatching {
                                getActionName.invoke(action) as? String
                            }.getOrNull()
                        } else null
                        localClearCandidate =
                            actionName == CLEAR_UNDERSTANDING_CONTEXT
                        val actionSourceValue = if (actionPresent) {
                            runCatching {
                                getActionSourceValue.invoke(action) as? Int
                            }.getOrNull()
                        } else null
                        if (
                            localClearCandidate &&
                            actionSourceValue == SYNAPSE_SERVER_SOURCE_VALUE
                        ) {
                            // Server Synapse remains the authoritative agentic path.
                            // This guard applies only to local interpreter results.
                            return
                        }
                        val clearAuthorization = localClearAuthorization(
                            actionName = actionName,
                            actionSourceValue = actionSourceValue,
                            currentUtterances = currentUtterances(
                                current = param.args.getOrNull(1),
                                hasUserRequest = hasUserRequest,
                                getUserRequest = getUserRequest,
                                getRequest = getRequest,
                            ),
                        )
                        if (clearAuthorization == false) {
                            // Setting the result in a before-hook skips stock's void
                            // method. A malformed or non-exact local clear therefore
                            // cannot reach LocalChatTurnService.
                            param.result = null
                            return
                        }
                        physicalVerificationActionName(
                            hasAction = actionPresent,
                            actionName = actionName,
                        )?.let { verifiedAction ->
                            Log.w(TAG, "$PHYSICAL_ACTION_MARKER | action=$verifiedAction")
                        }
                        if (
                            !shouldRepairLocalAction(
                                hasAction = actionPresent,
                                actionSourceValue = actionSourceValue,
                                identifier = getIdentifier.invoke(turn) as? String ?: "",
                                requiresResponse = getRequiresResponse.invoke(intermediate)
                                    as? Boolean ?: false,
                            )
                        ) {
                            if (clearAuthorization == true) {
                                Log.w(TAG, EXACT_RESET_MARKER)
                            }
                            return
                        }

                        val turnBuilder = turnCopyBuilder.invoke(null, turn)
                        setIdentifier.invoke(turnBuilder, UUID.randomUUID().toString())
                        val repairedTurn = buildTurn.invoke(turnBuilder)
                        val intermediateBuilder = intermediateCopyBuilder.invoke(null, intermediate)
                        setEvent.invoke(intermediateBuilder, repairedTurn)
                        setRequiresResponse.invoke(intermediateBuilder, true)
                        param.args[0] = buildIntermediate.invoke(intermediateBuilder)
                        Log.w(TAG, "Repaired identifier-less local action for streaming dispatch")
                        if (clearAuthorization == true) {
                            Log.w(TAG, EXACT_RESET_MARKER)
                        }
                    } catch (error: Throwable) {
                        if (localClearCandidate) {
                            // Once the action name is known, every failed source or
                            // utterance read is an authorization failure, not a reason
                            // to fall back to stock's permissive local dispatch.
                            param.result = null
                        }
                        Log.e(
                            TAG,
                            "Local streaming-action repair failed: " +
                                error.javaClass.simpleName,
                        )
                    }
                }
            })
            Log.w(TAG, "  Local streaming-action dispatch repair installed")
        } catch (error: Throwable) {
            Log.e(
                TAG,
                "Local streaming-action repair install failed: " +
                    "${error.javaClass.simpleName}: ${error.message}",
            )
        }
    }

    private fun logTruncation(historySize: Int) {
        val count = truncatedChains.incrementAndGet()
        if (count <= 3 || count % 100L == 0L) {
            Log.w(
                TAG,
                "Truncated cyclic/over-depth context chain " +
                    "(history turns=$historySize, total truncations=$count)",
            )
        }
    }

    internal fun <T : Any> inspectParentChain(
        head: T,
        historySize: Int,
        absoluteMaxDepth: Int = MAX_CHAIN_DEPTH,
        identifierOf: (T) -> String,
        parentOf: (T) -> T?,
    ): ParentChain<T> {
        val maximumDepth = minOf(
            historySize.coerceAtLeast(0) + 1,
            absoluteMaxDepth.coerceAtLeast(1),
        )
        val values = ArrayList<T>(minOf(maximumDepth, 32))
        val visitedObjects = Collections.newSetFromMap(IdentityHashMap<T, Boolean>())
        val visitedIdentifiers = HashSet<String>()
        var cursor: T? = head

        while (cursor != null) {
            val id = identifierOf(cursor)
            val repeatedObject = !visitedObjects.add(cursor)
            val repeatedIdentifier = id.isNotEmpty() && !visitedIdentifiers.add(id)
            if (repeatedObject || repeatedIdentifier || values.size >= maximumDepth) {
                return ParentChain(listOf(head), truncated = true)
            }
            values.add(cursor)
            cursor = parentOf(cursor)
        }

        return ParentChain(values, truncated = false)
    }

    internal fun shouldRepairLocalAction(
        hasAction: Boolean,
        actionSourceValue: Int?,
        identifier: String,
        requiresResponse: Boolean,
    ): Boolean =
        hasAction &&
            actionSourceValue == SYNAPSE_DEVICE_SOURCE_VALUE &&
            identifier.isEmpty() &&
            !requiresResponse

    /**
     * Null means this is not a guarded local clear and stock must remain
     * untouched. Local clear results are authorized only by one current user
     * utterance that is exactly the explicit reset command.
     */
    internal fun localClearAuthorization(
        actionName: String?,
        actionSourceValue: Int?,
        currentUtterances: List<*>?,
    ): Boolean? {
        if (actionName != CLEAR_UNDERSTANDING_CONTEXT) return null
        if (actionSourceValue == SYNAPSE_SERVER_SOURCE_VALUE) return null
        if (actionSourceValue != SYNAPSE_DEVICE_SOURCE_VALUE) return false
        val utterance = currentUtterances?.singleOrNull() as? String ?: return false
        return isExactResetUtterance(utterance)
    }

    internal fun isExactResetUtterance(rawUtterance: String): Boolean {
        // Line breaks are never normalized into authorization. This excludes
        // transcript concatenation and quoted/metalinguistic multi-line input.
        if ('\n' in rawUtterance || '\r' in rawUtterance) return false
        val normalized = rawUtterance
            .trim { character -> character in ASCII_HORIZONTAL_WHITESPACE }
            .replace(ASCII_HORIZONTAL_WHITESPACE_RUN, " ")
            .lowercase(Locale.ROOT)
        return normalized == "reset session"
    }

    private fun currentUtterances(
        current: Any?,
        hasUserRequest: Method,
        getUserRequest: Method,
        getRequest: Method,
    ): List<String>? {
        return try {
            current ?: return null
            if (hasUserRequest.invoke(current) as? Boolean != true) return null
            val request = getUserRequest.invoke(current) ?: return null
            val utterance = getRequest.invoke(request) as? String ?: return null
            listOf(utterance)
        } catch (_: Throwable) {
            null
        }
    }

    /**
     * Returns only closed-set, content-free action names used by the physical
     * verifier. Inputs, arguments, prompt text, and unknown action names never
     * cross this logging boundary.
     */
    internal fun physicalVerificationActionName(
        hasAction: Boolean,
        actionName: String?,
    ): String? = actionName?.takeIf { hasAction && it in physicalVerificationActions }

    /** Locate maxSecondsBetweenRuns without assuming which of the two stock
     * three-argument constructor orderings this firmware exposes. */
    internal fun sessionRetentionArgumentIndex(parameterTypes: Array<Class<*>>): Int? {
        if (parameterTypes.size != 3 || parameterTypes[0] != Int::class.javaPrimitiveType) {
            return null
        }
        return parameterTypes.indices
            .drop(1)
            .singleOrNull { index -> parameterTypes[index] == Int::class.javaPrimitiveType }
    }

    internal fun retainedSessionSeconds(): Int = RETAINED_SESSION_SECONDS

    /**
     * GeneratedMessageLite.toBuilder() is inherited from a generic base class, so
     * Java reflection reports its erased GeneratedMessageLite.Builder return type.
     * The generated static newBuilder(Self) overload preserves the concrete nested
     * Builder return type and therefore exposes message-specific setter methods.
     */
    internal fun findGeneratedCopyBuilderMethod(messageClass: Class<*>): Method? =
        runCatching { messageClass.getMethod("newBuilder", messageClass) }
            .getOrNull()
            ?.takeIf { method -> Modifier.isStatic(method.modifiers) }

    /**
     * Stock also contains a synthetic linearize lambda bridge with the same
     * parameter and return types. Select the actual unbounded walker by its
     * stable source name as well as its exact firmware signature.
     */
    internal fun findParentChainMethod(
        snapshotClass: Class<*>,
        turnClass: Class<*>,
        immutableListClass: Class<*>,
    ): Method? = snapshotClass.declaredMethods.singleOrNull { method ->
        method.name == PARENT_CHAIN_METHOD &&
            method.parameterTypes.contentEquals(arrayOf(turnClass)) &&
            method.returnType == immutableListClass
    }

    private val ASCII_HORIZONTAL_WHITESPACE = setOf(' ', '\t', '\u000B', '\u000C')
    private val ASCII_HORIZONTAL_WHITESPACE_RUN = Regex("[ \\t\\u000B\\u000C]+")
}
