package com.penumbraos.server

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class EsimConnectionAdmissionTest {
    @Test
    fun listenerAndGlobalCapsAreBothEnforcedAndReleased() {
        val admission = EsimConnectionAdmission(globalLimit = 3)
        val events = admission.listener(limit = 2)
        val control = admission.listener(limit = 2)

        val eventOne = events.tryAcquire()
        val eventTwo = events.tryAcquire()
        assertNotNull(eventOne)
        assertNotNull(eventTwo)
        assertNull(events.tryAcquire())

        val controlOne = control.tryAcquire()
        assertNotNull(controlOne)
        assertNull(control.tryAcquire())

        eventOne!!.close()
        val controlTwo = control.tryAcquire()
        assertNotNull(controlTwo)

        eventTwo!!.close()
        controlOne!!.close()
        controlTwo!!.close()
    }

    @Test
    fun leaseCleanupIsIdempotentOnEveryFailurePath() {
        val admission = EsimConnectionAdmission(globalLimit = 1)
        val listener = admission.listener(limit = 1)

        val first = listener.tryAcquire()
        assertNotNull(first)
        assertNull(listener.tryAcquire())

        first!!.close()
        first.close()

        val second = listener.tryAcquire()
        assertNotNull(second)
        second!!.close()
    }
}
