package com.penumbraos.hook

import android.util.Log
import com.penumbraos.stockaibus.contract.TierASymbols
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.lang.reflect.Field
import java.lang.reflect.Method
import java.util.regex.Pattern

/**
 * Keeps stock Tickle intent routing aligned with the live feature flag.
 *
 * Humane snapshots the flag independently while constructing its regex engine,
 * static action catalog, and JSON resolver. A flag update after those objects are
 * created therefore cannot launch the otherwise-complete stock Tickle experience.
 * These hooks repair only the Tickle entries and re-read THE_TICKLE for every
 * Tickle candidate. All other utterances and actions remain stock-owned.
 */
object TickleIntentCompatibilityHooks {
    private const val TAG = "PenumbraHook"
    private const val TICKLE_ACTION = TierASymbols.NativeActions.TICKLE
    private const val FEATURE_MANAGER =
        "humaneinternal.featureflag.FeatureFlagManager"
    private const val REGEX_ENGINE =
        "humaneinternal.system.intent.interpreters.regex.RegexIntentEngine"
    private const val ACTION_UTILS = "humaneinternal.system.utils.ActionUtils"
    private const val ACTION_CONTENT = "humane.aibus.SynapseActionContent"
    private const val CHAT_TURN = "humane.aibus.SynapseChatTurn"
    private const val JSON_RESOLVER = "humaneinternal.system.concierge.JsonResolver"
    private const val SCHEMA_CATALOG = "humaneinternal.system.concierge.SchemaCatalog"
    private const val TICKLE_ACTION_CLASS =
        "humaneinternal.system.intent.actions.tickle.TickleAction"

    private val tickleRegexSources = listOf(
        "tickle my fancy",
        "tickle tickle tickle",
        "tickle",
    )

    fun install(classLoader: ClassLoader) {
        val liveFlag = LiveTickleFlag.create(classLoader)
        var installed = 0
        if (installRegexEngineHook(classLoader, liveFlag)) installed++
        if (installActionValidationHook(classLoader, liveFlag)) installed++
        if (installJsonResolverHook(classLoader, liveFlag)) installed++
        Log.w(TAG, "  TickleIntentCompatibilityHooks installed $installed/3 stock gates")
    }

    private fun installRegexEngineHook(
        classLoader: ClassLoader,
        liveFlag: LiveTickleFlag,
    ): Boolean = try {
        val engineClass = classLoader.loadClass(REGEX_ENGINE)
        val process = engineClass.getDeclaredMethod(
            "process",
            String::class.java,
        ).apply { isAccessible = true }
        val compiledRegexes = engineClass.getDeclaredField(
            "compiledRegexes",
        ).apply { isAccessible = true }
        val groupNamesByRegex = engineClass.getDeclaredField(
            "groupNamesByRegex",
        ).apply { isAccessible = true }

        XposedBridge.hookMethod(process, object : XC_MethodHook() {
            override fun beforeHookedMethod(param: MethodHookParam) {
                val query = param.args.getOrNull(0) as? String ?: return
                if (!isExactTicklePhrase(query)) return

                if (!liveFlag.isEnabled()) {
                    // Stock would have no Tickle regex when the live flag is off.
                    param.result = emptyList<Any>()
                    return
                }

                try {
                    val repaired = ensureTickleRegexes(
                        compiledRegexes.mutableRegexMap(param.thisObject),
                        groupNamesByRegex.mutableGroupMap(param.thisObject),
                    )
                    if (repaired) Log.i(TAG, "  Repaired live Tickle regex entry")
                } catch (error: Throwable) {
                    logFailure("regex repair", error)
                }
            }
        })
        true
    } catch (error: Throwable) {
        logFailure("RegexIntentEngine.process install", error)
        false
    }

    private fun installActionValidationHook(
        classLoader: ClassLoader,
        liveFlag: LiveTickleFlag,
    ): Boolean = try {
        val contentClass = classLoader.loadClass(ACTION_CONTENT)
        val contentAction = contentClass.getDeclaredMethod(
            "getAction",
        ).apply { isAccessible = true }
        val actionUtilsClass = classLoader.loadClass(ACTION_UTILS)
        val isValidAction = actionUtilsClass.getDeclaredMethod(
            "isValidAction",
            contentClass,
        ).apply { isAccessible = true }

        XposedBridge.hookMethod(isValidAction, object : XC_MethodHook() {
            override fun beforeHookedMethod(param: MethodHookParam) {
                val actionName = actionName(
                    param.args.getOrNull(0),
                    contentAction,
                ) ?: return
                val override = liveTickleDecision(
                    actionName,
                    liveFlag::isEnabled,
                ) ?: return
                param.result = override
            }
        })
        true
    } catch (error: Throwable) {
        logFailure("ActionUtils.isValidAction install", error)
        false
    }

    private fun installJsonResolverHook(
        classLoader: ClassLoader,
        liveFlag: LiveTickleFlag,
    ): Boolean = try {
        val contentClass = classLoader.loadClass(ACTION_CONTENT)
        val contentAction = contentClass.getDeclaredMethod(
            "getAction",
        ).apply { isAccessible = true }
        val chatTurnClass = classLoader.loadClass(CHAT_TURN)
        val hasAction = chatTurnClass.getDeclaredMethod(
            "hasAction",
        ).apply { isAccessible = true }
        val turnAction = chatTurnClass.getDeclaredMethod(
            "getAction",
        ).apply { isAccessible = true }
        val resolverClass = classLoader.loadClass(JSON_RESOLVER)
        val resolve = resolverClass.getDeclaredMethod(
            "resolve",
            chatTurnClass,
            List::class.java,
        ).apply { isAccessible = true }
        val schemaCatalogField = resolverClass.getDeclaredField(
            "mSchemaCatalog",
        ).apply { isAccessible = true }
        val schemaCatalogClass = classLoader.loadClass(SCHEMA_CATALOG)
        val containsSchema = schemaCatalogClass.getDeclaredMethod(
            "containsSchema",
            String::class.java,
        ).apply { isAccessible = true }
        val addSchema = schemaCatalogClass.getDeclaredMethod(
            "add",
            Class::class.java,
        ).apply { isAccessible = true }
        val tickleActionClass = classLoader.loadClass(TICKLE_ACTION_CLASS)

        XposedBridge.hookMethod(resolve, object : XC_MethodHook() {
            override fun beforeHookedMethod(param: MethodHookParam) {
                val actionName = turnActionName(
                    param.args.getOrNull(0),
                    hasAction,
                    turnAction,
                    contentAction,
                ) ?: return
                val enabled = liveTickleDecision(
                    actionName,
                    liveFlag::isEnabled,
                ) ?: return
                if (!enabled) {
                    // Preserve JsonResolver's normal unresolvable result while off.
                    param.result = null
                    return
                }

                try {
                    val catalog = schemaCatalogField.get(param.thisObject)
                        ?: throw IllegalStateException("missing schema catalog")
                    val added = ensureTickleSchema(
                        catalog,
                        {
                            containsSchema.invoke(catalog, TICKLE_ACTION) as? Boolean == true
                        },
                        { addSchema.invoke(catalog, tickleActionClass) },
                    )
                    if (added) Log.i(TAG, "  Repaired live Tickle schema entry")
                } catch (error: Throwable) {
                    // The stock resolver will still return null if its schema is absent.
                    logFailure("schema repair", error)
                }
            }
        })
        true
    } catch (error: Throwable) {
        logFailure("JsonResolver.resolve install", error)
        false
    }

    /** RegexIntentEngine receives Interpreter.normalizeUtterance output. */
    internal fun isExactTicklePhrase(query: String): Boolean =
        query in tickleRegexSources

    /** Null means this is not a Tickle action and the stock result must be preserved. */
    internal fun liveTickleDecision(
        actionName: String?,
        readLiveFlag: () -> Boolean,
    ): Boolean? {
        if (actionName != TICKLE_ACTION) return null
        return runCatching(readLiveFlag).getOrDefault(false)
    }

    /**
     * Adds only missing stock Tickle patterns and their empty capture-group lists.
     * Synchronizing on the existing map makes repeated simultaneous callbacks
     * idempotent without replacing any stock or third-party entries.
     */
    internal fun ensureTickleRegexes(
        compiledRegexes: MutableMap<String, List<Pattern>>,
        groupNamesByRegex: MutableMap<Pattern, List<String>>,
    ): Boolean = synchronized(compiledRegexes) {
        val existing = compiledRegexes[TICKLE_ACTION].orEmpty()
        val merged = existing.toMutableList()
        val knownSources = existing.mapTo(HashSet()) { it.pattern() }
        var changed = false

        tickleRegexSources.forEach { source ->
            if (knownSources.add(source)) {
                merged.add(Pattern.compile(source))
                changed = true
            }
        }
        if (changed) compiledRegexes[TICKLE_ACTION] = merged

        merged.forEach { pattern ->
            if (!groupNamesByRegex.containsKey(pattern)) {
                groupNamesByRegex[pattern] = emptyList()
                changed = true
            }
        }
        changed
    }

    internal fun ensureTickleSchema(
        catalogLock: Any,
        containsSchema: () -> Boolean,
        addSchema: () -> Unit,
    ): Boolean = synchronized(catalogLock) {
        if (containsSchema()) {
            false
        } else {
            addSchema()
            true
        }
    }

    private fun actionName(content: Any?, contentAction: Method): String? =
        runCatching {
            content ?: return null
            contentAction.invoke(content) as? String
        }.getOrNull()

    private fun turnActionName(
        turn: Any?,
        hasAction: Method,
        turnAction: Method,
        contentAction: Method,
    ): String? = runCatching {
        turn ?: return null
        if (hasAction.invoke(turn) as? Boolean != true) return null
        actionName(turnAction.invoke(turn), contentAction)
    }.getOrNull()

    @Suppress("UNCHECKED_CAST")
    private fun Field.mutableRegexMap(owner: Any?): MutableMap<String, List<Pattern>> =
        get(owner) as? MutableMap<String, List<Pattern>>
            ?: throw IllegalStateException("missing compiled regex map")

    @Suppress("UNCHECKED_CAST")
    private fun Field.mutableGroupMap(owner: Any?): MutableMap<Pattern, List<String>> =
        get(owner) as? MutableMap<Pattern, List<String>>
            ?: throw IllegalStateException("missing regex group map")

    private class LiveTickleFlag private constructor(
        private val sharedInstance: Method?,
        private val getBoolValue: Method?,
        private val tickleFeature: Any?,
    ) {
        fun isEnabled(): Boolean {
            val shared = sharedInstance ?: return false
            val getter = getBoolValue ?: return false
            val feature = tickleFeature ?: return false
            return runCatching {
                val manager = shared.invoke(null) ?: return false
                getter.invoke(manager, feature) as? Boolean == true
            }.getOrDefault(false)
        }

        companion object {
            fun create(classLoader: ClassLoader): LiveTickleFlag = try {
                val managerClass = classLoader.loadClass(FEATURE_MANAGER)
                val featureClass = classLoader.loadClass("$FEATURE_MANAGER\$Feature")
                val shared = managerClass.getDeclaredMethod(
                    "sharedInstance",
                ).apply { isAccessible = true }
                val getter = managerClass.getDeclaredMethod(
                    "getBoolValue",
                    featureClass,
                ).apply { isAccessible = true }
                val feature = featureClass.getDeclaredField(
                    "THE_TICKLE",
                ).apply { isAccessible = true }.get(null)
                LiveTickleFlag(shared, getter, feature)
            } catch (error: Throwable) {
                logFailure("live feature reader initialization", error)
                LiveTickleFlag(null, null, null)
            }
        }
    }

    private fun logFailure(operation: String, error: Throwable) {
        Log.e(
            TAG,
            "  Tickle compatibility $operation failed: ${error.javaClass.simpleName}",
        )
    }
}
