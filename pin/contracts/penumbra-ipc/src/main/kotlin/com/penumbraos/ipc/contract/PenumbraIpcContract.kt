package com.penumbraos.ipc.contract

import android.os.IBinder
import com.penumbraos.stockaibus.contract.TierASymbols

/**
 * Transaction codes for the Binder protocols Penumbra defines between the Hook
 * (running inside a stock experience process) and the Server app.
 *
 * These are OUR protocols, not stock's — stock's `IAiBusBridge` surface lives in
 * `:contracts:stock-aibus` and must not be mixed in here.
 *
 * Each protocol used to declare its codes twice, once on the Hook side and once
 * on the Server side, sometimes under different names (`TRANSACTION_BEGIN`
 * versus `TRANSACTION_BEGIN_SESSION`). A drift between a pair is not a compile
 * error — it is a silent IPC failure at runtime, where one side transacts a code
 * the other does not handle. Declaring them once, in a module both sides depend
 * on, makes that class of mistake impossible.
 *
 * Codes are relative to [IBinder.FIRST_CALL_TRANSACTION]. Never renumber a live
 * protocol: a Hook and a Server from different releases can run against each
 * other on a device that was not updated atomically.
 */
object PenumbraIpcContract {

    /** Hook → Server: stock music playback observation and catalog queries. */
    object Spotify {
        const val DESCRIPTOR = TierASymbols.Binder.PenumbraSpotify.DESCRIPTOR
        const val TRANSACTION_QUERY =
            TierASymbols.Binder.PenumbraSpotify.TRANSACTION_QUERY
        const val TRANSACTION_PLAYBACK =
            TierASymbols.Binder.PenumbraSpotify.TRANSACTION_PLAYBACK
        const val TRANSACTION_SAVE =
            TierASymbols.Binder.PenumbraSpotify.TRANSACTION_SAVE
    }

    /** Hook → Server: stock fitness session lifecycle. */
    object Fitness {
        const val DESCRIPTOR = TierASymbols.Binder.PenumbraFitness.DESCRIPTOR
        const val TRANSACTION_BEGIN_SESSION =
            TierASymbols.Binder.PenumbraFitness.TRANSACTION_BEGIN_SESSION
        const val TRANSACTION_FINISH_SESSION =
            TierASymbols.Binder.PenumbraFitness.TRANSACTION_FINISH_SESSION
        const val TRANSACTION_ABORT_SESSION =
            TierASymbols.Binder.PenumbraFitness.TRANSACTION_ABORT_SESSION
    }

    /** Hook → Server: stock message delivery-state observation. */
    object MessageStatus {
        const val DESCRIPTOR = TierASymbols.Binder.PenumbraMessageStatus.DESCRIPTOR
        const val TRANSACTION_RECORD_DELIVERED =
            TierASymbols.Binder.PenumbraMessageStatus.TRANSACTION_RECORD_DELIVERED
    }

    /** Hook → Server: acknowledgement that a feature flag was applied. */
    object FeatureFlagApplyAck {
        const val DESCRIPTOR =
            TierASymbols.Binder.PenumbraFeatureFlagApplyAck.DESCRIPTOR
        const val TRANSACTION_RECORD_APPLIED =
            TierASymbols.Binder.PenumbraFeatureFlagApplyAck.TRANSACTION_RECORD_APPLIED
    }
}
