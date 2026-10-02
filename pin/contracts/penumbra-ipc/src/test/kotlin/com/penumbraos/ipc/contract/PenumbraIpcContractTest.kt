package com.penumbraos.ipc.contract

import com.penumbraos.stockaibus.contract.TierASymbols
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pins the wire values. These codes cross a process boundary between a Hook and
 * a Server that are not guaranteed to be from the same release, so renumbering
 * one is a runtime-compatibility break rather than a refactor.
 */
class PenumbraIpcContractTest {

    @Test
    fun spotifyCodesAreStable() {
        assertEquals(
            TierASymbols.Binder.PenumbraSpotify.DESCRIPTOR,
            PenumbraIpcContract.Spotify.DESCRIPTOR,
        )
        assertEquals(
            TierASymbols.Binder.PenumbraSpotify.TRANSACTION_QUERY,
            PenumbraIpcContract.Spotify.TRANSACTION_QUERY,
        )
        assertEquals(
            TierASymbols.Binder.PenumbraSpotify.TRANSACTION_PLAYBACK,
            PenumbraIpcContract.Spotify.TRANSACTION_PLAYBACK,
        )
        assertEquals(
            TierASymbols.Binder.PenumbraSpotify.TRANSACTION_SAVE,
            PenumbraIpcContract.Spotify.TRANSACTION_SAVE,
        )
    }

    @Test
    fun fitnessCodesAreStable() {
        assertEquals(
            TierASymbols.Binder.PenumbraFitness.DESCRIPTOR,
            PenumbraIpcContract.Fitness.DESCRIPTOR,
        )
        assertEquals(
            TierASymbols.Binder.PenumbraFitness.TRANSACTION_BEGIN_SESSION,
            PenumbraIpcContract.Fitness.TRANSACTION_BEGIN_SESSION,
        )
        assertEquals(
            TierASymbols.Binder.PenumbraFitness.TRANSACTION_FINISH_SESSION,
            PenumbraIpcContract.Fitness.TRANSACTION_FINISH_SESSION,
        )
        assertEquals(
            TierASymbols.Binder.PenumbraFitness.TRANSACTION_ABORT_SESSION,
            PenumbraIpcContract.Fitness.TRANSACTION_ABORT_SESSION,
        )
    }

    @Test
    fun singleTransactionProtocolsAreStable() {
        assertEquals(
            TierASymbols.Binder.PenumbraMessageStatus.DESCRIPTOR,
            PenumbraIpcContract.MessageStatus.DESCRIPTOR,
        )
        assertEquals(
            TierASymbols.Binder.PenumbraMessageStatus.TRANSACTION_RECORD_DELIVERED,
            PenumbraIpcContract.MessageStatus.TRANSACTION_RECORD_DELIVERED,
        )
        assertEquals(
            TierASymbols.Binder.PenumbraFeatureFlagApplyAck.DESCRIPTOR,
            PenumbraIpcContract.FeatureFlagApplyAck.DESCRIPTOR,
        )
        assertEquals(
            TierASymbols.Binder.PenumbraFeatureFlagApplyAck.TRANSACTION_RECORD_APPLIED,
            PenumbraIpcContract.FeatureFlagApplyAck.TRANSACTION_RECORD_APPLIED,
        )
    }

    @Test
    fun codesWithinAProtocolAreDistinct() {
        val spotify = listOf(
            PenumbraIpcContract.Spotify.TRANSACTION_QUERY,
            PenumbraIpcContract.Spotify.TRANSACTION_PLAYBACK,
            PenumbraIpcContract.Spotify.TRANSACTION_SAVE,
        )
        assertEquals(spotify.size, spotify.toSet().size)

        val fitness = listOf(
            PenumbraIpcContract.Fitness.TRANSACTION_BEGIN_SESSION,
            PenumbraIpcContract.Fitness.TRANSACTION_FINISH_SESSION,
            PenumbraIpcContract.Fitness.TRANSACTION_ABORT_SESSION,
        )
        assertEquals(fitness.size, fitness.toSet().size)
    }
}
