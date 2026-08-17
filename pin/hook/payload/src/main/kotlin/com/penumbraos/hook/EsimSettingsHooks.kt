package com.penumbraos.hook

import android.util.Log
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.lang.reflect.Constructor
import java.lang.reflect.Method

/**
 * Relax Settings-side eSIM QR acceptance.
 */
object EsimSettingsHooks {

    private const val TAG = "PenumbraHook"
    private val LAX_ESIM_REGEX = Regex("(?i)^LPA:1\\$.+\\$.+$")

    fun install(cl: ClassLoader) {
        try {
            val interactorClass = cl.loadClass("humane.experience.settings.node.EsimScanInteractor")
            val resultClass = cl.loadClass("com.google.zxing.Result")
            val resultParserClass = cl.loadClass("com.google.zxing.client.result.ResultParser")

            val parserClass = cl.loadClass("humane.experience.settings.node.EsimScanInteractor\$EsimResultParser")
            val parsedResultClass = cl.loadClass("humane.experience.settings.node.EsimScanInteractor\$EsimParsedResult")

            val getMassagedText: Method = resultParserClass.getDeclaredMethod("getMassagedText", resultClass)
            getMassagedText.isAccessible = true

            val parsedResultCtor: Constructor<*> = parsedResultClass.getDeclaredConstructor(
                interactorClass,
                String::class.java,
                Short::class.javaPrimitiveType!!,
            )
            parsedResultCtor.isAccessible = true

            val parseMethod = parserClass.getDeclaredMethod("parse", resultClass)
            parseMethod.isAccessible = true

            XposedBridge.hookMethod(parseMethod, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val result = param.args[0] ?: return
                    if (!resultClass.isInstance(result)) {
                        Log.w(TAG, "  eSIM settings hook: parse() arg was not ZXing Result")
                        return
                    }

                    val massagedText = try {
                        getMassagedText.invoke(null, result) as? String
                    } catch (t: Throwable) {
                        Log.e(TAG, "  eSIM settings hook: failed to massage QR text (${t.javaClass.simpleName})")
                        return
                    } ?: return

                    if (!LAX_ESIM_REGEX.matches(massagedText)) {
                        return
                    }

                    val interactor = try {
                        val this0Field = param.thisObject.javaClass.getDeclaredField("this$0")
                        this0Field.isAccessible = true
                        this0Field.get(param.thisObject)
                    } catch (t: Throwable) {
                        Log.e(TAG, "  eSIM settings hook: failed to resolve outer interactor (${t.javaClass.simpleName})")
                        return
                    }

                    param.result = try {
                        parsedResultCtor.newInstance(interactor, massagedText, 0.toShort())
                    } catch (t: Throwable) {
                        Log.e(TAG, "  eSIM settings hook: failed to create EsimParsedResult (${t.javaClass.simpleName})")
                        return
                    }

                    Log.w(TAG, "  eSIM settings hook: accepted activation code via lax parser policy")
                }
            })

            Log.w(TAG, "  eSIM settings hook installed (EsimResultParser.parse)")
        } catch (t: Throwable) {
            Log.e(TAG, "  Failed to install eSIM settings hook", t)
        }
    }
}
