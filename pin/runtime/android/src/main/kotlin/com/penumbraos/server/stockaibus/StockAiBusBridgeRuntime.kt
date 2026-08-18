package com.penumbraos.server.stockaibus

import android.content.Context
import android.content.pm.PackageManager
import android.os.Binder
import android.os.IBinder
import android.os.Parcel
import com.penumbraos.stockaibus.contract.StockAiBusBridgeBinder
import com.penumbraos.stockaibus.contract.StockParcelableMessageCodec
import com.penumbraos.stockaibus.contract.StockProtoEnvelope
import com.penumbraos.stockaibus.contract.StockStreamObserverProxy
import com.penumbraos.stockaibus.contract.TierASymbols
import java.util.concurrent.atomic.AtomicReference

/** Server-owned implementation of selected stock IAiBusBridge transactions. */
internal object StockAiBusBridgeRuntime {
    private const val IRONMAN_PACKAGE = TierASymbols.Packages.IRONMAN

    // The Android platform package. Every genuine stock component on the Pin — the
    // platform itself, ironman, and the humane.experience.* experiences — is signed
    // with Humane's platform key, so co-signing with `android` is a satisfiable,
    // always-present proof that a caller claiming to be ironman really is stock.
    private const val PLATFORM_PACKAGE = "android"

    private val client = AtomicReference<StockAiBusGrpcClient?>()
    private val binder = AtomicReference<IBinder?>()

    fun configure(port: Int, authToken: String) {
        val next = StockAiBusGrpcClient.connect(port, authToken)
        client.getAndSet(next)?.close()
    }

    fun clear() {
        client.getAndSet(null)?.close()
    }

    fun isReady(): Boolean = client.get()?.isReady() == true

    fun requestConnection() {
        client.get()?.requestConnection()
    }

    fun binder(context: Context): IBinder = binder.updateAndGet { existing ->
        existing ?: createBinder(context.applicationContext)
    }!!

    private fun createBinder(context: Context): IBinder = StockAiBusBridgeBinder(
        callerAuthorized = {
            callerIsIronman(
                context.packageManager,
                Binder.getCallingUid(),
            )
        },
        handler = StockAiBusBridgeBinder.TransactionHandler { transaction, data, reply ->
            when (transaction.code) {
                TRANSACTION_SYNAPSE_UNDERSTANDING -> {
                    handleSynapseUnderstanding(data, reply)
                    true
                }
                TRANSACTION_ENCRYPTED_NEARBY_SEARCH -> {
                    handleEncryptedNearbySearch(data, reply)
                    true
                }
                else -> false
            }
        },
    )

    private fun handleSynapseUnderstanding(data: Parcel, reply: Parcel) {
        val request = StockParcelableMessageCodec.readRequiredTypedObject(data)
        require(request.className == StockAiBusProtoCodec.UNDERSTAND_REQUEST_KID) {
            "Unexpected stock Understand request type"
        }
        val location = StockParcelableMessageCodec.readOptionalTypedObject(data)
        require(location == null || location.className == StockAiBusProtoCodec.LOCATION_KID) {
            "Unexpected stock location envelope type"
        }
        val runId = requireNotNull(data.readString()) { "Stock Understand run ID is required" }
        val observerBinder = requireNotNull(data.readStrongBinder()) {
            "Stock Understand response observer is required"
        }
        require(data.dataAvail() == 0) { "Unexpected stock Understand parcel data" }

        val observer = StockStreamObserverProxy(observerBinder)
        val current = client.get()
        if (current == null) {
            observer.onError("UNAVAILABLE")
        } else {
            current.synapseUnderstanding(
                request.payload,
                location?.payload,
                runId,
                object : StockAiBusGrpcClient.Observer {
                    override fun onNext(value: ByteArray) {
                        observer.onNext(
                            StockProtoEnvelope.create(
                                StockAiBusProtoCodec.UNDERSTAND_RESPONSE_KID,
                                value,
                            ),
                        )
                    }

                    override fun onError(code: String) {
                        observer.onError(code)
                    }

                    override fun onCompleted() {
                        observer.onCompleted()
                    }
                },
            )
        }
        reply.writeNoException()
    }

    private fun handleEncryptedNearbySearch(data: Parcel, reply: Parcel) {
        val request = StockParcelableMessageCodec.readRequiredTypedObject(data)
        require(request.className == StockAiBusProtoCodec.NEARBY_REQUEST_KID) {
            "Unexpected stock Nearby request type"
        }
        require(data.dataAvail() == 0) { "Unexpected stock Nearby parcel data" }

        // Match stock's failure contract: transport/provider failures return the
        // default response rather than escaping across Binder and destabilizing
        // ironman. The stock Nearby UI already renders that response as an error.
        val response = client.get()?.let { current ->
            runCatching { current.encryptedNearbySearch(request.payload) }.getOrNull()
        } ?: ByteArray(0)
        reply.writeNoException()
        StockParcelableMessageCodec.writeRequiredTypedObject(
            reply,
            StockProtoEnvelope.create(StockAiBusProtoCodec.NEARBY_RESPONSE_KID, response),
        )
    }

    internal fun callerIsIronman(
        packageManager: PackageManager,
        callingUid: Int,
    ): Boolean {
        val expectedUid = try {
            packageManager.getPackageUid(IRONMAN_PACKAGE, 0)
        } catch (_: PackageManager.NameNotFoundException) {
            return false
        }
        val packages = packageManager.getPackagesForUid(callingUid).orEmpty().toSet()
        // Confirm ironman is genuinely stock-signed by comparing it against the
        // platform — both contain Humane's platform key. The previous check compared
        // ironman against the SERVER (`checkSignatures(ironman, serverPackage)`),
        // which can never match: our server is signed with our own key, not
        // Humane's. That rejected the real ironman on every transaction, so the
        // stock side crash-looped "AiBridge: no mAiBusBridge yet" and the touchpad
        // never reached the assistant.
        val ironmanIsStockSigned =
            packageManager.checkSignatures(IRONMAN_PACKAGE, PLATFORM_PACKAGE) ==
                PackageManager.SIGNATURE_MATCH
        return isAuthorizedIronmanCaller(
            callingUid,
            expectedUid,
            packages,
            ironmanIsStockSigned,
        )
    }

    internal fun isAuthorizedIronmanCaller(
        callingUid: Int,
        expectedUid: Int?,
        packagesForUid: Set<String>,
        ironmanIsStockSigned: Boolean,
    ): Boolean = expectedUid != null &&
        callingUid == expectedUid &&
        packagesForUid == setOf(IRONMAN_PACKAGE) &&
        ironmanIsStockSigned

    private const val TRANSACTION_SYNAPSE_UNDERSTANDING =
        TierASymbols.Binder.AiBusBridge.TRANSACTION_SYNAPSE_UNDERSTANDING
    private const val TRANSACTION_ENCRYPTED_NEARBY_SEARCH =
        TierASymbols.Binder.AiBusBridge.TRANSACTION_ENCRYPTED_NEARBY_SEARCH
}
