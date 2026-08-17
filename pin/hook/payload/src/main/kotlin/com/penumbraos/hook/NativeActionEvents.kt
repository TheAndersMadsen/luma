package com.penumbraos.hook

import android.util.Log
import java.util.Collections

/**
 * Builds the same native action events as Humane's local intent interpreters.
 *
 * The hook is compiled without Humane's private classes, so this adapter keeps
 * the reflection in one place. Callers still hand the resulting events to the
 * stock orchestrator, action resolver, experience, and UI.
 */
object NativeActionEvents {
    private const val TAG = "PenumbraHook"

    fun create(
        classLoader: ClassLoader,
        actionName: String,
        stringInputs: Map<String, String> = emptyMap(),
        listInputs: Map<String, List<String>> = emptyMap(),
    ): Any? = try {
        val factoryClass = classLoader.loadClass(
            "humaneinternal.system.intent.interpreters.ActionContentFactory",
        )
        val actionContentClass = classLoader.loadClass("humane.aibus.SynapseActionContent")
        val chatTurnClass = classLoader.loadClass("humane.aibus.SynapseChatTurn")
        val utilsClass = classLoader.loadClass(
            "humaneinternal.system.intent.SynapseChatTurnUtils",
        )

        val factoryMethod = factoryClass.methods.firstOrNull { method ->
            method.name == "of" &&
                method.parameterTypes.contentEquals(
                    arrayOf(String::class.java, Map::class.java, Map::class.java),
                )
        } ?: error("ActionContentFactory.of(String, Map, Map) not found")

        val actionContent = factoryMethod.invoke(
            null,
            actionName,
            stringInputs,
            listInputs,
        ) ?: error("ActionContentFactory returned null")

        val builder = chatTurnClass.getMethod("newBuilder").invoke(null)
            ?: error("SynapseChatTurn.newBuilder returned null")
        builder.javaClass.getMethod("setAction", actionContentClass)
            .invoke(builder, actionContent)
        val turn = builder.javaClass.getMethod("build").invoke(builder)
            ?: error("SynapseChatTurn.Builder.build returned null")

        utilsClass.getMethod("toSupervisorIntermediateEvents", List::class.java)
            .invoke(null, Collections.singletonList(turn))
    } catch (error: Throwable) {
        Log.e(
            TAG,
            "NativeActionEvents.create($actionName) failed: " +
                "${error.javaClass.simpleName}: ${error.message}",
        )
        null
    }
}
