package com.penumbraos.hook

import android.util.Log
import com.penumbraos.stockaibus.contract.TierASymbols
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.lang.reflect.Method
import java.nio.ByteBuffer

/**
 * Exact Food-process compatibility for the retired Krypton service.
 *
 * Only the three stock Food AI Bus contracts are converted to plaintext
 * envelopes. Every other channel and protobuf delegates to the original stock
 * implementation. The local gRPC transport independently authenticates the
 * stock Food package before the Server accepts any envelope.
 */
object EphemeralProtectionBypass {

    private const val TAG = "PenumbraHook"

    private const val CHAT_COMPLETION_CHANNEL = "ai_bus.chat_completion"
    private const val GET_FOOD_ITEM_CHANNEL = "ai_bus.get_food_item"
    private const val ANALYZE_IMAGE_CHANNEL = "ai_bus.analyze_image"

    private val FOOD_REQUESTS = mapOf(
        CHAT_COMPLETION_CHANNEL to TierASymbols.ProtoKids.CHAT_COMPLETION_REQUEST,
        GET_FOOD_ITEM_CHANNEL to TierASymbols.ProtoKids.GET_FOOD_ITEM_REQUEST,
        ANALYZE_IMAGE_CHANNEL to TierASymbols.ProtoKids.ANALYZE_FOOD_IMAGE_REQUEST,
    )
    private val FOOD_RESPONSES = mapOf(
        CHAT_COMPLETION_CHANNEL to TierASymbols.ProtoKids.CHAT_COMPLETION_RESPONSE,
        GET_FOOD_ITEM_CHANNEL to TierASymbols.ProtoKids.GET_FOOD_ITEM_RESPONSE,
        ANALYZE_IMAGE_CHANNEL to TierASymbols.ProtoKids.ANALYZE_FOOD_IMAGE_RESPONSE,
    )

    fun installFoodOnly(cl: ClassLoader) {
        val epmClassName = "humaneinternal.system.krypto.ephemeral.EphemeralProtectionManager"
        val epmClass = try {
            cl.loadClass(epmClassName)
        } catch (_: ClassNotFoundException) {
            Log.w(TAG, "  $epmClassName not found, skipping ephemeral protection bypass")
            return
        }

        val channelIdClass = cl.loadClass("hu.ma.ne.krypton.ephemeral.EphemeralChannelId")
        val generatedMessageLiteClass = cl.loadClass("com.google.protobuf.GeneratedMessageLite")
        val encryptedDataClass = cl.loadClass("humane.common.encryption.EncryptedData")
        val encryptionInfoClass = cl.loadClass("humane.common.encryption.EncryptionInformation")

        // Pre-resolve builder methods for EncryptedData and EncryptionInformation
        val edNewBuilder = encryptedDataClass.getMethod("newBuilder")
        val eiNewBuilder = encryptionInfoClass.getMethod("newBuilder")

        // ByteString.copyFrom(byte[])
        val byteStringClass = cl.loadClass("com.google.protobuf.ByteString")
        val byteStringCopyFrom = byteStringClass.getMethod("copyFrom", ByteArray::class.java)

        // ─── prepare() overloads → return true ────────────────────────

        hookPrepare(epmClass, channelIdClass)
        hookPrepareWithTimeout(epmClass, channelIdClass)

        // ─── encrypt() overloads → plaintext passthrough ──────────────

        hookEncrypt(
            epmClass, channelIdClass, generatedMessageLiteClass,
            edNewBuilder, eiNewBuilder, byteStringCopyFrom, byteStringClass, encryptionInfoClass,
        )
        hookEncryptWithTimeout(
            epmClass, channelIdClass, generatedMessageLiteClass,
            edNewBuilder, eiNewBuilder, byteStringCopyFrom, byteStringClass, encryptionInfoClass,
        )

        // ─── decrypt() → plaintext passthrough ────────────────────────

        hookDecrypt(epmClass, channelIdClass, encryptedDataClass, cl)

        Log.w(TAG, "  Food-only ephemeral compatibility installed on $epmClassName")
    }

    internal fun shouldPrepareFoodChannel(channel: String?): Boolean =
        channel != null && FOOD_REQUESTS.containsKey(channel)

    internal fun shouldBypassFoodEncrypt(channel: String?, payloadClass: String?): Boolean =
        channel != null && payloadClass == FOOD_REQUESTS[channel]

    internal fun shouldBypassFoodDecrypt(channel: String?, payloadClass: String?): Boolean =
        channel != null && payloadClass == FOOD_RESPONSES[channel]

    // ─── prepare() hooks ──────────────────────────────────────────────

    private fun hookPrepare(epmClass: Class<*>, channelIdClass: Class<*>) {
        try {
            val method = epmClass.getDeclaredMethod("prepare", channelIdClass)
            method.isAccessible = true
            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    if (!shouldPrepareFoodChannel(param.args.getOrNull(0)?.toString())) return
                    param.result = true
                }
            })
            Log.w(TAG, "  Hooked EphemeralProtectionManager.prepare(EphemeralChannelId)")
        } catch (t: Throwable) {
            Log.e(TAG, "  Failed to hook prepare(EphemeralChannelId): ${t.message}")
        }
    }

    private fun hookPrepareWithTimeout(epmClass: Class<*>, channelIdClass: Class<*>) {
        try {
            val method = epmClass.getDeclaredMethod(
                "prepare", channelIdClass, java.time.Duration::class.java,
            )
            method.isAccessible = true
            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    if (!shouldPrepareFoodChannel(param.args.getOrNull(0)?.toString())) return
                    param.result = true
                }
            })
            Log.w(TAG, "  Hooked EphemeralProtectionManager.prepare(EphemeralChannelId, Duration)")
        } catch (t: Throwable) {
            Log.e(TAG, "  Failed to hook prepare(EphemeralChannelId, Duration): ${t.message}")
        }
    }

    // ─── encrypt() hooks ──────────────────────────────────────────────

    /**
     * Build a plaintext EncryptedData envelope via reflection:
     *   EncryptedData {
     *     data: raw proto bytes (as ByteString),
     *     encryptionInformation: EncryptionInformation { kid: java class name }
     *   }
     */
    private fun buildPlaintextEnvelope(
        proto: Any,
        edNewBuilder: Method,
        eiNewBuilder: Method,
        byteStringCopyFrom: Method,
        byteStringClass: Class<*>,
        encryptionInfoClass: Class<*>,
    ): Any {
        // Serialize the proto: proto.toByteArray() -> byte[]
        val toByteArray = proto.javaClass.getMethod("toByteArray")
        val rawBytes = toByteArray.invoke(proto) as ByteArray
        val className = proto.javaClass.name

        // Build EncryptionInformation { kid: className }
        val eiBuilder = eiNewBuilder.invoke(null)
        val setKid = eiBuilder.javaClass.getMethod("setKid", String::class.java)
        setKid.invoke(eiBuilder, className)
        val eiBuild = eiBuilder.javaClass.getMethod("build")
        val encInfo = eiBuild.invoke(eiBuilder)

        // Build EncryptedData { data: ByteString(rawBytes), encryptionInformation: encInfo }
        val edBuilder = edNewBuilder.invoke(null)
        val byteString = byteStringCopyFrom.invoke(null, rawBytes)
        // Use the pre-resolved ByteString class for method lookup — the runtime
        // concrete class (e.g. ByteString$LiteralByteString) won't match the
        // declared parameter type of setData(ByteString).
        val setData = edBuilder.javaClass.getMethod("setData", byteStringClass)
        setData.invoke(edBuilder, byteString)
        val setEncInfo = edBuilder.javaClass.getMethod("setEncryptionInformation", encryptionInfoClass)
        setEncInfo.invoke(edBuilder, encInfo)

        val edBuild = edBuilder.javaClass.getMethod("build")
        return edBuild.invoke(edBuilder)
    }

    private fun hookEncrypt(
        epmClass: Class<*>,
        channelIdClass: Class<*>,
        generatedMessageLiteClass: Class<*>,
        edNewBuilder: Method,
        eiNewBuilder: Method,
        byteStringCopyFrom: Method,
        byteStringClass: Class<*>,
        encryptionInfoClass: Class<*>,
    ) {
        try {
            val method = epmClass.getDeclaredMethod(
                "encrypt", channelIdClass, generatedMessageLiteClass,
            )
            method.isAccessible = true
            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val channel = param.args.getOrNull(0)?.toString()
                    val proto = param.args[1]
                    if (!shouldBypassFoodEncrypt(channel, proto?.javaClass?.name)) return
                    try {
                        param.result = buildPlaintextEnvelope(
                            proto, edNewBuilder, eiNewBuilder, byteStringCopyFrom, byteStringClass, encryptionInfoClass,
                        )
                    } catch (t: Throwable) {
                        Log.e(TAG, "  encrypt() bypass failed: ${t.message}", t)
                        // Let original method run (will likely fail too)
                        return
                    }
                }
            })
            Log.w(TAG, "  Hooked EphemeralProtectionManager.encrypt(EphemeralChannelId, GeneratedMessageLite)")
        } catch (t: Throwable) {
            Log.e(TAG, "  Failed to hook encrypt(2-arg): ${t.message}")
        }
    }

    private fun hookEncryptWithTimeout(
        epmClass: Class<*>,
        channelIdClass: Class<*>,
        generatedMessageLiteClass: Class<*>,
        edNewBuilder: Method,
        eiNewBuilder: Method,
        byteStringCopyFrom: Method,
        byteStringClass: Class<*>,
        encryptionInfoClass: Class<*>,
    ) {
        try {
            val method = epmClass.getDeclaredMethod(
                "encrypt", channelIdClass, generatedMessageLiteClass,
                java.time.Duration::class.java,
            )
            method.isAccessible = true
            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val channel = param.args.getOrNull(0)?.toString()
                    val proto = param.args[1]
                    if (!shouldBypassFoodEncrypt(channel, proto?.javaClass?.name)) return
                    try {
                        param.result = buildPlaintextEnvelope(
                            proto, edNewBuilder, eiNewBuilder, byteStringCopyFrom, byteStringClass, encryptionInfoClass,
                        )
                    } catch (t: Throwable) {
                        Log.e(TAG, "  encrypt() bypass failed: ${t.message}", t)
                        return
                    }
                }
            })
            Log.w(TAG, "  Hooked EphemeralProtectionManager.encrypt(EphemeralChannelId, GeneratedMessageLite, Duration)")
        } catch (t: Throwable) {
            Log.e(TAG, "  Failed to hook encrypt(3-arg): ${t.message}")
        }
    }

    // ─── decrypt() hook ───────────────────────────────────────────────

    private fun hookDecrypt(
        epmClass: Class<*>,
        channelIdClass: Class<*>,
        encryptedDataClass: Class<*>,
        cl: ClassLoader,
    ) {
        try {
            val method = epmClass.getDeclaredMethod(
                "decrypt", channelIdClass, encryptedDataClass,
            )
            method.isAccessible = true
            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val channel = param.args.getOrNull(0)?.toString()
                    val encryptedData = param.args[1]
                    try {
                        // Extract EncryptionInformation.kid (the class name)
                        val getEncInfo = encryptedData.javaClass.getMethod("getEncryptionInformation")
                        val encInfo = getEncInfo.invoke(encryptedData)
                        val getKid = encInfo.javaClass.getMethod("getKid")
                        val className = getKid.invoke(encInfo) as String

                        if (!shouldBypassFoodDecrypt(channel, className)) return

                        // Extract data bytes: EncryptedData.getData() -> ByteString
                        val getData = encryptedData.javaClass.getMethod("getData")
                        val byteString = getData.invoke(encryptedData)
                        val toByteArray = byteString.javaClass.getMethod("toByteArray")
                        val rawBytes = toByteArray.invoke(byteString) as ByteArray

                        // Reconstruct the proto: Class.forName(className).parseFrom(byte[])
                        val protoClass = cl.loadClass(className)
                        val parseFrom = protoClass.getMethod("parseFrom", ByteArray::class.java)
                        val result = parseFrom.invoke(null, rawBytes)

                        param.result = result
                    } catch (t: Throwable) {
                        Log.e(TAG, "  decrypt() bypass failed: ${t.message}", t)
                        // Let original method run
                        return
                    }
                }
            })
            Log.w(TAG, "  Hooked Food response decrypt compatibility")
        } catch (t: Throwable) {
            Log.e(TAG, "  Failed to hook decrypt: ${t.message}")
        }
    }
}
