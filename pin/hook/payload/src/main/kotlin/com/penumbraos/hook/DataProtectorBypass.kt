package com.penumbraos.hook

import android.util.Log
import com.penumbraos.stockaibus.contract.TierASymbols
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.lang.reflect.Method
import java.nio.ByteBuffer

/**
 * Bypass Krypton data protection so all captured data arrives as plaintext.
 *
 * There are multiple app-layer protection facades in the Humane APKs:
 * - dependency.implementations.DataProtectorWrapper, used by photography/capture
 * - humaneinternal.system.dataprotection.DataProtectionUtils, used by notable events
 * - hu.ma.ne.dataprotection.util.ProtectionManager, a general encryption helper
 *
 * We hook those API boundaries and return plaintext EncryptedData/ProtectedData
 * envelopes instead of letting calls fall through to Krypto key creation/upload.
 */
object DataProtectorBypass {

    private const val TAG = "PenumbraHook"
    private const val PLAINTEXT_KID = TierASymbols.WireSentinels.PLAINTEXT_ENVELOPE
    private const val FOOD_SERVICE_WRAPPER =
        "humane.experience.food.dependency.implementations.FoodServiceWrapper"
    private const val FOOD_LOG_CLASS = "humane.common.food.FoodLog"
    private const val FOOD_LOG_SUMMARY_CLASS = TierASymbols.ProtoKids.FOOD_LOG_SUMMARY
    private const val FOOD_DOMAIN_NAME = "Food"
    private const val MAX_FOOD_LOG_BYTES = 64 * 1024
    private const val MAX_FOOD_LOG_SUMMARY_BYTES = (2 * 1024 * 1024) + (64 * 1024)

    fun install(cl: ClassLoader) {
        hookDataProtectionUtils(cl)
        hookProtectionManager(cl)
        hookDataProtectorWrapper(cl)
        hookFoodCoreDataProtector(cl)
    }

    /** Install only the exact FoodLog/FoodLogSummary persistence contracts. */
    fun installFoodOnly(cl: ClassLoader) {
        hookFoodCoreDataProtector(cl)
    }

    /**
     * The stock food experience does not use any of the higher-level facades above.
     * [FoodServiceWrapper] calls the FOOD_DOMAIN [IDataProtector] directly:
     *
     *  * `protect(identity, userId, FoodLog, null)` before Capture.CreateMemory
     *  * `reveal(identity, rawFoodLogSummaryBytes)` after Capture.GetFoodLogSummary
     *
     * Hook only those two exact food contracts. Other domains and protobuf types keep
     * their normal protector behavior. If a summary is not a bounded, canonical
     * FoodLogSummary protobuf, leave the original reveal method alone so legacy
     * ciphertext can still use the stock decrypt path.
     */
    private fun hookFoodCoreDataProtector(cl: ClassLoader) {
        // Scope this hook to humane.experience.food. Several other stock processes
        // bundle CoreDataProtector and must not receive a broad reveal bypass.
        try {
            cl.loadClass(FOOD_SERVICE_WRAPPER)
        } catch (_: ClassNotFoundException) {
            return
        }

        val coreDataProtectorClass =
            tryLoad(cl, "hu.ma.ne.dataprotection.CoreDataProtector") ?: return
        val protectedDataClass =
            tryLoad(cl, "hu.ma.ne.dataprotection.data.ProtectedData") ?: return
        val personalDataClass =
            tryLoad(cl, "hu.ma.ne.dataprotection.data.PersonalData") ?: return
        val krKeyIdClass = tryLoad(cl, "hu.ma.ne.krypton.key.KrKeyId") ?: return
        val simpleKrKeyIdClass = tryLoad(cl, "hu.ma.ne.krypton.key.SimpleKrKeyId") ?: return
        val foodLogSummaryClass = tryLoad(cl, FOOD_LOG_SUMMARY_CLASS) ?: return

        val protectedDataCtor = try {
            protectedDataClass.getConstructor(
                krKeyIdClass,
                Int::class.javaPrimitiveType,
                Int::class.javaPrimitiveType,
                ByteBuffer::class.java,
            )
        } catch (t: Throwable) {
            Log.e(TAG, "  Food plaintext protect constructor unavailable: ${t.message}")
            return
        }
        val personalDataCtor = try {
            personalDataClass.getConstructor(
                Int::class.javaPrimitiveType,
                Int::class.javaPrimitiveType,
                Class::class.java,
                Any::class.java,
                Class::class.java,
                Any::class.java,
            )
        } catch (t: Throwable) {
            Log.e(TAG, "  Food plaintext reveal constructor unavailable: ${t.message}")
            return
        }
        val plaintextFoodKeyId = try {
            simpleKrKeyIdClass.getConstructor(String::class.java).newInstance(FOOD_LOG_CLASS)
        } catch (t: Throwable) {
            Log.e(TAG, "  Food plaintext key ID unavailable: ${t.message}")
            return
        }
        val parseFoodLogSummary = try {
            foodLogSummaryClass.getMethod("parseFrom", ByteArray::class.java)
        } catch (t: Throwable) {
            Log.e(TAG, "  FoodLogSummary.parseFrom(byte[]) unavailable: ${t.message}")
            return
        }

        var protectHooks = 0
        for (method in coreDataProtectorClass.declaredMethods) {
            if (method.name != "protect" || method.parameterTypes.size != 4) continue
            if (method.returnType != protectedDataClass) continue
            method.isAccessible = true
            try {
                XposedBridge.hookMethod(method, object : XC_MethodHook() {
                    override fun beforeHookedMethod(param: MethodHookParam) {
                        val payload = param.args.getOrNull(2) ?: return
                        val rawBytes = protoToBytes(payload) ?: return
                        if (!shouldBypassFoodProtect(payload.javaClass.name, rawBytes.size)) return

                        val domainId = protectorDomainId(param.thisObject)
                        val objectId = protectorObjectId(param.thisObject, payload.javaClass)
                        param.result = protectedDataCtor.newInstance(
                            plaintextFoodKeyId,
                            domainId,
                            objectId,
                            ByteBuffer.wrap(rawBytes),
                        )
                        Log.w(
                            TAG,
                            "  Food IDataProtector.protect(FoodLog) → plaintext " +
                                "ProtectedData (${rawBytes.size} bytes)",
                        )
                    }
                })
                protectHooks++
            } catch (t: Throwable) {
                Log.e(TAG, "  Failed to hook food ${method.name}${signature(method)}: ${t.message}")
            }
        }

        var revealHooks = 0
        for (method in coreDataProtectorClass.declaredMethods) {
            if (method.name != "reveal" || method.parameterTypes.size != 2) continue
            if (method.parameterTypes[1] != ByteBuffer::class.java) continue
            if (method.returnType != personalDataClass) continue
            method.isAccessible = true
            try {
                XposedBridge.hookMethod(method, object : XC_MethodHook() {
                    override fun beforeHookedMethod(param: MethodHookParam) {
                        val input = param.args.getOrNull(1) as? ByteBuffer ?: return
                        val rawBytes = byteBufferToBytes(input)
                        val domainName = protectorDomainName(param.thisObject)
                        if (!shouldAttemptFoodSummaryReveal(domainName, rawBytes.size)) return

                        val summary = try {
                            parseFoodLogSummary.invoke(null, rawBytes)
                        } catch (_: Throwable) {
                            return
                        }
                        val canonicalBytes = protoToBytes(summary) ?: return
                        if (!isCanonicalPlaintext(rawBytes, canonicalBytes)) return

                        val domainId = protectorDomainId(param.thisObject)
                        val objectId = protectorObjectId(param.thisObject, foodLogSummaryClass)
                        param.result = personalDataCtor.newInstance(
                            domainId,
                            objectId,
                            foodLogSummaryClass,
                            summary,
                            null,
                            null,
                        )
                        Log.w(
                            TAG,
                            "  Food IDataProtector.reveal(FoodLogSummary) → plaintext " +
                                "PersonalData (${rawBytes.size} bytes)",
                        )
                    }
                })
                revealHooks++
            } catch (t: Throwable) {
                Log.e(TAG, "  Failed to hook food ${method.name}${signature(method)}: ${t.message}")
            }
        }

        if (protectHooks > 0 && revealHooks > 0) {
            Log.w(
                TAG,
                "  Food direct IDataProtector plaintext bypass installed " +
                    "($protectHooks protect, $revealHooks reveal)",
            )
        } else {
            Log.e(
                TAG,
                "  Food direct IDataProtector bypass incomplete " +
                    "($protectHooks protect, $revealHooks reveal)",
            )
        }
    }

    /**
     * NotableEventsManager uses these static helpers directly:
     * DataProtectionUtils.protectData(IDataProtector, Struct, DataProtectionIdentity)
     * DataProtectionUtils.protectData(IDataProtector, int, ByteBuffer, DataProtectionIdentity)
     * DataProtectionUtils.protectData(IDataProtector, Note, DataProtectionIdentity)
     */
    private fun hookDataProtectionUtils(cl: ClassLoader) {
        val clazz = tryLoad(cl, "humaneinternal.system.dataprotection.DataProtectionUtils") ?: return
        val iDataProtectorClass = tryLoad(cl, "hu.ma.ne.dataprotection.IDataProtector") ?: return
        val identityClass = tryLoad(cl, "hu.ma.ne.dataprotection.DataProtectionIdentity") ?: return
        val structClass = tryLoad(cl, "com.google.protobuf.Struct")
        val noteClass = tryLoad(cl, "humane.capture.Note")

        var hooked = 0

        if (structClass != null) {
            hooked += hookStaticPlaintextEncryptedDataMethod(
                cl,
                clazz,
                "protectData",
                arrayOf(iDataProtectorClass, structClass, identityClass),
                payloadArgIndex = 1,
                label = "DataProtectionUtils.protectData(Struct)",
            )
        }

        hooked += hookStaticPlaintextEncryptedDataMethod(
            cl,
            clazz,
            "protectData",
            arrayOf(iDataProtectorClass, Int::class.javaPrimitiveType!!, ByteBuffer::class.java, identityClass),
            payloadArgIndex = 2,
            label = "DataProtectionUtils.protectData(ByteBuffer)",
        )

        if (noteClass != null) {
            hooked += hookStaticPlaintextEncryptedDataMethod(
                cl,
                clazz,
                "protectData",
                arrayOf(iDataProtectorClass, noteClass, identityClass),
                payloadArgIndex = 1,
                label = "DataProtectionUtils.protectData(Note)",
            )
        }

        if (hooked > 0) {
            Log.w(TAG, "  DataProtectionUtils plaintext bypass installed ($hooked overload(s))")
        } else {
            Log.w(TAG, "  DataProtectionUtils found but no protectData overloads were hooked")
        }
    }

    /**
     * General data-protection helper. Hook all encryptProto overloads returning
     * humane.common.encryption.EncryptedData and synthesize plaintext envelopes.
     */
    private fun hookProtectionManager(cl: ClassLoader) {
        val clazz = tryLoad(cl, "hu.ma.ne.dataprotection.util.ProtectionManager") ?: return
        val encryptedDataClass = tryLoad(cl, "humane.common.encryption.EncryptedData") ?: return
        var hooked = 0

        for (method in clazz.declaredMethods) {
            if (method.name != "encryptProto") continue
            if (method.returnType != encryptedDataClass) continue

            method.isAccessible = true
            try {
                XposedBridge.hookMethod(method, object : XC_MethodHook() {
                    override fun beforeHookedMethod(param: MethodHookParam) {
                        val payload = findEncryptProtoPayload(param.args)
                        val rawBytes = payloadToBytes(payload)
                        if (rawBytes == null) {
                            Log.w(TAG, "  ProtectionManager.encryptProto() plaintext bypass skipped: unsupported payload ${payload?.javaClass?.name}")
                            return
                        }

                        param.result = buildEncryptedData(cl, rawBytes, plaintextKidFor(payload))
                        Log.w(TAG, "  ProtectionManager.encryptProto() → plaintext EncryptedData (${rawBytes.size} bytes)")
                    }
                })
                hooked++
            } catch (t: Throwable) {
                Log.e(TAG, "  Failed to hook ProtectionManager.${method.name}${signature(method)}: ${t.message}")
            }
        }

        if (hooked > 0) {
            Log.w(TAG, "  ProtectionManager plaintext bypass installed ($hooked overloads)")
        } else {
            Log.w(TAG, "  ProtectionManager found but no encryptProto overloads were hooked")
        }
    }

    /**
     * Existing photography/capture wrapper bypass.
     */
    private fun hookDataProtectorWrapper(cl: ClassLoader) {
        val className = "dependency.implementations.DataProtectorWrapper"
        val clazz = try {
            cl.loadClass(className)
        } catch (e: ClassNotFoundException) {
            Log.w(TAG, "  $className not found, skipping wrapper encryption bypass hooks")
            return
        }

        // Pre-load reflection targets used by multiple hooks
        val simpleKrKeyIdClass = try {
            cl.loadClass("hu.ma.ne.krypton.key.SimpleKrKeyId")
        } catch (e: ClassNotFoundException) {
            Log.e(TAG, "  SimpleKrKeyId not found — cannot install wrapper encryption bypass")
            return
        }
        val protectedDataClass = try {
            cl.loadClass("hu.ma.ne.dataprotection.data.ProtectedData")
        } catch (e: ClassNotFoundException) {
            Log.e(TAG, "  ProtectedData not found — cannot install wrapper encryption bypass")
            return
        }
        val krKeyIdClass = try {
            cl.loadClass("hu.ma.ne.krypton.key.KrKeyId")
        } catch (e: ClassNotFoundException) {
            Log.e(TAG, "  KrKeyId not found — cannot install wrapper encryption bypass")
            return
        }

        // Constructor: SimpleKrKeyId(String)
        val simpleKrKeyIdCtor = simpleKrKeyIdClass.getConstructor(String::class.java)

        // Constructor: ProtectedData(KrKeyId, int, int, ByteBuffer)
        val protectedDataCtor = protectedDataClass.getConstructor(
            krKeyIdClass,
            Int::class.javaPrimitiveType,
            Int::class.javaPrimitiveType,
            ByteBuffer::class.java,
        )

        // Create a reusable fake key ID
        val fakeKeyId = simpleKrKeyIdCtor.newInstance(PLAINTEXT_KID)

        // ─── Hook 1: createKey(int[]) -> KrKeyId ───────────────────────
        HookUtils.hookMethodBefore(
            clazz,
            "createKey",
            arrayOf(IntArray::class.java),
        ) { param ->
            param.result = fakeKeyId
            Log.w(TAG, "  DataProtector.createKey() → plaintext key (bypassed)")
        }

        // ─── Hook 2: protectDataWithExistingKey(ByteBuffer, KrKeyId, int, PersonalFlatMetadata) -> ProtectedData ───
        val personalFlatMetaClass = try {
            cl.loadClass("humane.personaldata.PersonalFlatMetadata")
        } catch (e: ClassNotFoundException) {
            Log.w(TAG, "  PersonalFlatMetadata not found, skipping protectDataWithExistingKey hook")
            null
        }

        if (personalFlatMetaClass != null) {
            HookUtils.hookMethodBefore(
                clazz,
                "protectDataWithExistingKey",
                arrayOf<Class<*>>(
                    ByteBuffer::class.java,
                    krKeyIdClass,
                    Int::class.javaPrimitiveType!!,
                    personalFlatMetaClass,
                ),
            ) { param ->
                val inputBuffer = param.args[0] as ByteBuffer
                val keyId = param.args[1] // KrKeyId
                val objectId = param.args[2] as Int

                // Duplicate the buffer so the caller's position isn't affected
                val dupBuffer = inputBuffer.duplicate()

                param.result = protectedDataCtor.newInstance(keyId, 0, objectId, dupBuffer)

                val size = dupBuffer.remaining()
                Log.w(TAG, "  DataProtector.protectDataWithExistingKey() → plaintext passthrough ($size bytes)")
            }
        }

        // ─── Hook 3: protectProtoWithNewKey(GeneratedMessageLite, PersonalProtoMetadata) -> ProtectedData ───
        val personalProtoMetaClass = try {
            cl.loadClass("humane.personaldata.PersonalProtoMetadata")
        } catch (e: ClassNotFoundException) {
            Log.w(TAG, "  PersonalProtoMetadata not found, skipping protectProtoWithNewKey hook")
            null
        }
        val generatedMessageLiteClass = try {
            cl.loadClass("com.google.protobuf.GeneratedMessageLite")
        } catch (e: ClassNotFoundException) {
            Log.w(TAG, "  GeneratedMessageLite not found, skipping protectProtoWithNewKey hook")
            null
        }

        if (personalProtoMetaClass != null && generatedMessageLiteClass != null) {
            HookUtils.hookMethodBefore(
                clazz,
                "protectProtoWithNewKey",
                arrayOf(generatedMessageLiteClass, personalProtoMetaClass),
            ) { param ->
                val rawBytes = protoToBytes(param.args[0]) ?: ByteArray(0)

                val buffer = ByteBuffer.wrap(rawBytes)
                param.result = protectedDataCtor.newInstance(fakeKeyId, 0, 0, buffer)

                Log.w(TAG, "  DataProtector.protectProtoWithNewKey() → plaintext serialized proto (${rawBytes.size} bytes)")
            }
        }

        Log.w(TAG, "  Wrapper encryption bypass hooks installed on $className")
    }

    private fun hookStaticPlaintextEncryptedDataMethod(
        cl: ClassLoader,
        clazz: Class<*>,
        name: String,
        paramTypes: Array<Class<*>>,
        payloadArgIndex: Int,
        label: String,
    ): Int {
        return try {
            val method = clazz.getDeclaredMethod(name, *paramTypes)
            method.isAccessible = true
            XposedBridge.hookMethod(method, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val payload = param.args[payloadArgIndex]
                    val rawBytes = payloadToBytes(payload)
                    if (rawBytes == null) {
                        Log.w(TAG, "  $label plaintext bypass skipped: unsupported payload ${payload?.javaClass?.name}")
                        return
                    }

                    param.result = buildEncryptedData(cl, rawBytes, plaintextKidFor(payload))
                    Log.w(TAG, "  $label → plaintext EncryptedData (${rawBytes.size} bytes)")
                }
            })
            Log.w(TAG, "  Hooked $label")
            1
        } catch (t: Throwable) {
            Log.w(TAG, "  Failed to hook $label: ${t.message}")
            0
        }
    }

    private fun buildEncryptedData(cl: ClassLoader, data: ByteArray, kid: String): Any {
        val byteStringClass = cl.loadClass("com.google.protobuf.ByteString")
        val encryptionInfoClass = cl.loadClass("humane.common.encryption.EncryptionInformation")
        val encryptedDataClass = cl.loadClass("humane.common.encryption.EncryptedData")

        val byteString = byteStringClass.getMethod("copyFrom", ByteArray::class.java).invoke(null, data)

        val encryptionInfoBuilder = encryptionInfoClass.getMethod("newBuilder").invoke(null)
        encryptionInfoBuilder.javaClass.getMethod("setKid", String::class.java)
            .invoke(encryptionInfoBuilder, kid)
        val encryptionInfo = encryptionInfoBuilder.javaClass.getMethod("build").invoke(encryptionInfoBuilder)

        val encryptedDataBuilder = encryptedDataClass.getMethod("newBuilder").invoke(null)
        encryptedDataBuilder.javaClass.getMethod("setEncryptionInformation", encryptionInfoClass)
            .invoke(encryptedDataBuilder, encryptionInfo)
        encryptedDataBuilder.javaClass.getMethod("setData", byteStringClass)
            .invoke(encryptedDataBuilder, byteString)
        return encryptedDataBuilder.javaClass.getMethod("build").invoke(encryptedDataBuilder)
    }

    private fun payloadToBytes(payload: Any?): ByteArray? {
        if (payload == null) return null
        return when (payload) {
            is ByteArray -> payload
            is ByteBuffer -> byteBufferToBytes(payload)
            else -> protoToBytes(payload)
        }
    }

    private fun protoToBytes(proto: Any?): ByteArray? {
        if (proto == null) return null
        return try {
            val method = proto.javaClass.getMethod("toByteArray")
            method.invoke(proto) as ByteArray
        } catch (_: Throwable) {
            null
        }
    }

    private fun byteBufferToBytes(buffer: ByteBuffer): ByteArray {
        val dup = buffer.duplicate()
        val out = ByteArray(dup.remaining())
        dup.get(out)
        return out
    }

    private fun findEncryptProtoPayload(args: Array<Any?>): Any? {
        // ByteBuffer overloads are explicit payload overloads.
        args.firstOrNull { it is ByteBuffer }?.let { return it }

        // Proto overloads carry identity/user/metadata String-ish args; pick the
        // first object that can actually serialize itself as protobuf bytes.
        return args.firstOrNull { arg ->
            arg != null && arg !is String && protoToBytes(arg) != null
        }
    }

    private fun plaintextKidFor(payload: Any?): String {
        val type = payload?.javaClass?.name ?: "unknown"
        return "$PLAINTEXT_KID:$type"
    }

    internal fun shouldBypassFoodProtect(payloadClassName: String?, payloadByteCount: Int): Boolean =
        payloadClassName == FOOD_LOG_CLASS && payloadByteCount in 0..MAX_FOOD_LOG_BYTES

    internal fun shouldAttemptFoodSummaryReveal(domainName: String?, payloadByteCount: Int): Boolean =
        domainName == FOOD_DOMAIN_NAME && payloadByteCount in 0..MAX_FOOD_LOG_SUMMARY_BYTES

    internal fun isCanonicalPlaintext(original: ByteArray, canonical: ByteArray): Boolean =
        original.contentEquals(canonical)

    private fun protectorDomainInfo(protector: Any?): Any? {
        if (protector == null) return null
        return try {
            protector.javaClass.getMethod("getDomainInfo").invoke(protector)
        } catch (_: Throwable) {
            null
        }
    }

    private fun protectorDomainName(protector: Any?): String? {
        val info = protectorDomainInfo(protector) ?: return null
        return try {
            info.javaClass.getMethod("getName").invoke(info) as? String
        } catch (_: Throwable) {
            null
        }
    }

    private fun protectorDomainId(protector: Any?): Int {
        val info = protectorDomainInfo(protector) ?: return 0
        return try {
            info.javaClass.getMethod("getId").invoke(info) as? Int ?: 0
        } catch (_: Throwable) {
            0
        }
    }

    private fun protectorObjectId(protector: Any?, protoClass: Class<*>): Int {
        if (protector == null) return 0
        return try {
            val field = findField(protector.javaClass, "objects") ?: return 0
            field.isAccessible = true
            val objects = field.get(protector) ?: return 0
            val getId = objects.javaClass.getMethod("getId", Class::class.java)
            getId.invoke(objects, protoClass) as? Int ?: 0
        } catch (_: Throwable) {
            0
        }
    }

    private fun findField(clazz: Class<*>, name: String): java.lang.reflect.Field? {
        var current: Class<*>? = clazz
        while (current != null) {
            try {
                return current.getDeclaredField(name)
            } catch (_: NoSuchFieldException) {
                current = current.superclass
            }
        }
        return null
    }

    private fun tryLoad(cl: ClassLoader, className: String): Class<*>? {
        return try {
            cl.loadClass(className)
        } catch (_: ClassNotFoundException) {
            Log.w(TAG, "  $className not found, skipping related encryption bypass hook")
            null
        }
    }

    private fun signature(method: Method): String {
        return method.parameterTypes.joinToString(prefix = "(", postfix = ")") { it.simpleName }
    }
}
