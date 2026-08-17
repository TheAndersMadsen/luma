package com.penumbraos.hook

import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.lang.reflect.Constructor
import java.lang.reflect.Method

/**
 * Shared hook utilities.
 */
object HookUtils {

    private const val TAG = "PenumbraHook"

    /**
     * Hook a method with a before-hook that replaces the call entirely.
     *
     * The [beforeHook] callback should set `param.result` to short-circuit
     * the original method. For void methods, set `param.result = null`.
     */
    fun hookMethodBefore(
        clazz: Class<*>,
        name: String,
        paramTypes: Array<Class<*>>,
        beforeHook: (XC_MethodHook.MethodHookParam) -> Unit,
    ): Boolean {
        return try {
            val method: Method = clazz.getDeclaredMethod(name, *paramTypes)
            method.isAccessible = true
            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    beforeHook(param)
                }
            })
            Log.w(TAG, "  Hooked ${clazz.simpleName}.$name()")
            true
        } catch (t: Throwable) {
            Log.e(TAG, "  Failed to hook ${clazz.simpleName}.$name: ${t.message}")
            false
        }
    }

    /**
     * Hook a method with an after-hook for observing or patching results/exceptions.
     */
    fun hookMethodAfter(
        clazz: Class<*>,
        name: String,
        paramTypes: Array<Class<*>>,
        afterHook: (XC_MethodHook.MethodHookParam) -> Unit,
    ): Boolean {
        return try {
            val method: Method = clazz.getDeclaredMethod(name, *paramTypes)
            method.isAccessible = true
            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    afterHook(param)
                }
            })
            Log.w(TAG, "  Hooked ${clazz.simpleName}.$name()")
            true
        } catch (t: Throwable) {
            Log.e(TAG, "  Failed to hook ${clazz.simpleName}.$name: ${t.message}")
            false
        }
    }

    /**
     * Hook one exact constructor with a before-hook.
     *
     * Constructor lookup deliberately uses the verified parameter list instead
     * of selecting the first declared constructor, whose ordering is unspecified.
     */
    fun hookConstructorBefore(
        clazz: Class<*>,
        paramTypes: Array<Class<*>>,
        beforeHook: (XC_MethodHook.MethodHookParam) -> Unit,
    ): Boolean {
        return try {
            val constructor = findExactConstructor(clazz, paramTypes)
            constructor.isAccessible = true
            XposedBridge.hookMethod(constructor, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    beforeHook(param)
                }
            })
            Log.w(TAG, "  Hooked ${clazz.simpleName}.<init>()")
            true
        } catch (t: Throwable) {
            Log.e(TAG, "  Failed to hook ${clazz.simpleName}.<init>: ${t.message}")
            false
        }
    }

    /** Hook one exact constructor with an after-hook. */
    fun hookConstructorAfter(
        clazz: Class<*>,
        paramTypes: Array<Class<*>>,
        afterHook: (XC_MethodHook.MethodHookParam) -> Unit,
    ): Boolean {
        return try {
            val constructor = findExactConstructor(clazz, paramTypes)
            constructor.isAccessible = true
            XposedBridge.hookMethod(constructor, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    afterHook(param)
                }
            })
            Log.w(TAG, "  Hooked ${clazz.simpleName}.<init>()")
            true
        } catch (t: Throwable) {
            Log.e(TAG, "  Failed to hook ${clazz.simpleName}.<init>: ${t.message}")
            false
        }
    }

    internal fun findExactConstructor(
        clazz: Class<*>,
        paramTypes: Array<Class<*>>,
    ): Constructor<*> = clazz.getDeclaredConstructor(*paramTypes)

    /**
     * Summarize an argument for logging without calling toString() on potentially
     * large or sensitive objects.
     */
    fun summarizeArg(arg: Any?): String {
        if (arg == null) return "null"
        return try {
            when (arg) {
                is String -> "\"$arg\""
                is Number, is Boolean -> arg.toString()
                is Enum<*> -> arg.name
                else -> "${arg.javaClass.simpleName}@${System.identityHashCode(arg).toString(16)}"
            }
        } catch (t: Throwable) {
            "${arg.javaClass.simpleName}(toString failed)"
        }
    }
}
