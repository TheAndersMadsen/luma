package dk.andersmadsen.cosmos.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class NativeEventTest {
    private val base = """{"version":1,"kind":"state","operation":"display","outcome":"ok","error":null,
        "connected":true,"pendingOpen":false,"needsReconnect":false,
        "descriptor":{"enrollmentId":"11111111-1111-4111-8111-111111111111","publicKey":"k","platform":"android","approval":"native-shared-speech-v3"},
        "pending":null,"lastUnknown":null,"admission":null,"visible":true,"eventsSkipped":0,"speech":null,"display":%s}"""

    private val speech = """{"actionId":"55555555-5555-4555-8555-555555555555","turnId":"44444444-4444-4444-8444-444444444444",
        "generation":3,"contentDigest":"${"b".repeat(64)}","expiresAtMs":1000,"text":"A spoken answer.","format":"audio/mpeg","byteLength":1234}"""

    private val places = """{"actionId":"33333333-3333-4333-8333-333333333333","turnId":"44444444-4444-4444-8444-444444444444",
        "generation":2,"contentDigest":"${"a".repeat(64)}","expiresAtMs":1000,
        "content":{"kind":"places","query":"Café & Bakery","items":[{"placeId":"one","name":"Café","address":"1 Main Street","sourceUrl":"https://www.google.com/maps/place/?q=cafe"}],
        "attributions":["Credit: <a href=\"https://credits.example\">Map</a>"]},
        "credits":[[{"kind":"text","text":"Credit: "},{"kind":"link","text":"Map","href":"https://credits.example"}]]}"""

    @Test
    fun decodesPlaceCardsWithInertCredits() {
        val event = NativeEvent.decode(base.format(places).toByteArray())
        val card = event.display!!
        val content = card.content as DisplayContent.Places
        assertEquals("Café & Bakery", content.query)
        assertEquals(listOf(CreditPart.Text("Credit: "), CreditPart.Link("Map", "https://credits.example")), content.credits.single())
        assertEquals("android", event.descriptor!!.platform)
        val tv = NativeEvent.decode(base.format(places).replace("\"platform\":\"android\"", "\"platform\":\"android_tv\"").toByteArray())
        assertEquals("android_tv", tv.descriptor!!.platform)
    }

    @Test
    fun decodesSpokenRepliesOnlyWhileConnected() {
        val event = NativeEvent.decode(base.format("null").replace("\"speech\":null", "\"speech\":$speech").replace("\"operation\":\"display\"", "\"operation\":\"speech\"").toByteArray())
        assertEquals("A spoken answer.", event.speech!!.text)
        assertEquals(1234, event.speech!!.byteLength)
        val disconnected = base.format("null").replace("\"speech\":null", "\"speech\":$speech").replace("\"connected\":true", "\"connected\":false")
        assertNull(NativeEvent.decode(disconnected.toByteArray()).speech)
        assertThrows(Exception::class.java) { NativeEvent.decode(base.format("null").replace("\"speech\":null", "\"speech\":${speech.replace("audio/mpeg", "audio/wav")}").toByteArray()) }
    }

    @Test
    fun rejectsForeignDescriptorsMarkupCreditsAndInconsistentOutcomes() {
        assertThrows(Exception::class.java) { NativeEvent.decode(base.format(places).replace("\"platform\":\"android\"", "\"platform\":\"macos\"").toByteArray()) }
        assertThrows(Exception::class.java) { NativeEvent.decode(base.format(places.replace("\"kind\":\"link\"", "\"kind\":\"html\"")).toByteArray()) }
        assertThrows(Exception::class.java) { NativeEvent.decode(base.format("null").replace("\"outcome\":\"ok\"", "\"outcome\":\"error\"").toByteArray()) }
        val disconnected = base.format(places).replace("\"connected\":true", "\"connected\":false")
        assertNull(NativeEvent.decode(disconnected.toByteArray()).display)
    }
}
