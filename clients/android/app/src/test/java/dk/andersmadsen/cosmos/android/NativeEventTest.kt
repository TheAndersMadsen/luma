package dk.andersmadsen.cosmos.android

import dk.andersmadsen.cosmos.android.action.DevicePolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeEventTest {
    private val base = """{"version":1,"kind":"state","operation":"display","outcome":"ok","error":null,
        "connected":true,"pendingOpen":false,"needsReconnect":false,
        "descriptor":{"enrollmentId":"11111111-1111-4111-8111-111111111111","publicKey":"k","platform":"android","approval":"native-device-action-v4"},
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

    private val task = """{"actionId":"66666666-6666-4666-8666-666666666666","turnId":"44444444-4444-4444-8444-444444444444",
        "generation":7,"channel":"action.route","contentDigest":"${"3".repeat(64)}","idempotencyKey":"${"a".repeat(64)}",
        "operation":{"kind":"route","placeId":"places/x","name":"Restaurant Barr","address":"Strandgade 93",
        "lat":"55.673611","lng":"12.596944"},"expiresAtMs":1757260000000,"reportByMs":1757260030000,"privacy":"shared_room"}"""

    private val confirmation = """{"grantId":"77777777-7777-4777-8777-777777777777","actionId":"66666666-6666-4666-8666-666666666666",
        "turnId":"44444444-4444-4444-8444-444444444444","generation":7,
        "description":{"kind":"device_action","verb":"open","subject":"PR 412","deviceKind":"android",
        "effect":"It opens a link in your browser.","class":"shared_room"},
        "descriptionDigest":"${"9".repeat(64)}","risk":"moderate","attestation":"foreground_tap",
        "privacy":"shared_room","expiresAtMs":1757259860000}"""

    @Test
    fun decodesACommandItsCeremonyAndItsRetirement() {
        val event = NativeEvent.decode(
            base.format("null")
                .replace("\"speech\":null", "\"speech\":null,\"task\":$task,\"confirmation\":$confirmation")
                .replace("\"operation\":\"display\"", "\"operation\":\"task\"")
                .toByteArray(),
        )
        val command = event.task!!
        assertEquals("action.route", command.channel)
        assertEquals("a".repeat(64), command.idempotencyKey)
        val operation = command.operation as dk.andersmadsen.cosmos.android.action.Operation.Route
        assertEquals("Restaurant Barr", operation.name)
        assertEquals("55.673611", operation.lat)
        assertEquals("open", event.confirmation!!.description.verb)
        assertEquals(dk.andersmadsen.cosmos.android.action.Attestation.FOREGROUND_TAP, event.confirmation!!.attestation)
        val revoked = NativeEvent.decode(
            base.format("null")
                .replace("\"speech\":null", """"speech":null,"revoked":{"actionId":"66666666-6666-4666-8666-666666666666","reason":"preempted"}""")
                .toByteArray(),
        )
        assertEquals(dk.andersmadsen.cosmos.android.action.RevokeReason.PREEMPTED, revoked.revoked!!.reason)
    }

    @Test
    fun refusesACommandOnAChannelOrShapeThisBuildDoesNotKnow() {
        val foreign = task.replace("\"action.route\"", "\"action.frobnicate\"")
        assertThrows(Exception::class.java) {
            NativeEvent.decode(base.format("null").replace("\"speech\":null", "\"speech\":null,\"task\":$foreign").toByteArray())
        }
        // An operation shape this build cannot carry out decodes as unsupported,
        // so it can be refused with a reason instead of taking the client down.
        val unknown = task.replace("\"kind\":\"route\"", "\"kind\":\"teleport\"")
        val event = NativeEvent.decode(base.format("null").replace("\"speech\":null", "\"speech\":null,\"task\":$unknown").toByteArray())
        assertEquals(
            dk.andersmadsen.cosmos.android.action.Operation.Unsupported("teleport"),
            event.task!!.operation,
        )
    }

    private val policy = """{"surfaceId":"22222222-2222-4222-8222-222222222222","approvalRevision":4,
        "actionsRevision":2,"commandsRevision":null,"digest":"${"7".repeat(64)}","byteLength":214}"""

    private fun withPolicy(policy: String?): String = base.format("null")
        .replace("\"speech\":null", "\"speech\":null,\"policy\":${policy ?: "null"}")
        .replace("\"operation\":\"display\"", "\"operation\":\"policy\"")

    @Test
    fun decodesTheCopyOfTheOwnersPermissionThisInstallationHolds() {
        val held = NativeEvent.decode(withPolicy(policy).toByteArray())
        assertEquals("policy", held.operation)
        assertEquals(java.util.UUID.fromString("22222222-2222-4222-8222-222222222222"), held.policy!!.surfaceId)
        assertEquals(4L, held.policy!!.approvalRevision)
        assertEquals(2L, held.policy!!.actionsRevision)
        // A phone and a television never run commands, so that section is absent.
        assertNull(held.policy!!.commandsRevision)
        assertEquals("7".repeat(64), held.policy!!.digest)
        assertEquals(214, held.policy!!.byteLength)
        // Withdrawn, absent and disconnected all read as holding nothing, which
        // is an ordinary state: this device then carries nothing out at all.
        assertNull(NativeEvent.decode(withPolicy(null).toByteArray()).policy)
        assertNull(NativeEvent.decode(base.format("null").toByteArray()).policy)
        assertNull(NativeEvent.decode(withPolicy(policy).replace("\"connected\":true", "\"connected\":false").toByteArray()).policy)
    }

    @Test
    fun refusesAPolicyTheSnapshotNamesOutOfShape() {
        val refused = { broken: String -> assertThrows(Exception::class.java) { NativeEvent.decode(withPolicy(broken).toByteArray()) } }
        refused(policy.replace("\"${"7".repeat(64)}\"", "\"${"7".repeat(63)}\""))
        refused(policy.replace("\"byteLength\":214", "\"byteLength\":0"))
        refused(policy.replace("\"byteLength\":214", "\"byteLength\":${DevicePolicy.MAX_POLICY_BYTES + 1}"))
        refused(policy.replace("\"approvalRevision\":4", "\"approvalRevision\":0"))
        refused(policy.replace("\"actionsRevision\":2", "\"actionsRevision\":0"))
        // A copy that names no section at all is a shape the runtime never sends.
        refused(policy.replace("\"actionsRevision\":2", "\"actionsRevision\":null"))
        refused(policy.replace("22222222-2222-4222-8222-222222222222", "00000000-0000-0000-0000-000000000000"))
    }

    @Test
    fun aWaitingCommandNeedsNoPrivateClassAndAWaitingCardStillDoes() {
        val invite = { kind: String, privacy: String ->
            base.format("null").replace(
                "\"speech\":null",
                """"speech":null,"invitation":{"id":"88888888-8888-4888-8888-888888888888","kind":"$kind","origin":"pin","privacy":"$privacy","expiresAtMs":1757260000000}""",
            ).toByteArray()
        }
        assertEquals("task", NativeEvent.decode(invite("task", "shared_room")).invitation!!.kind)
        assertTrue(NativeEvent.decode(invite("task", "shared_room")).invitation!!.forTask)
        assertEquals("card", NativeEvent.decode(invite("card", "private")).invitation!!.kind)
        assertThrows(Exception::class.java) { NativeEvent.decode(invite("card", "shared_room")) }
        assertThrows(Exception::class.java) { NativeEvent.decode(invite("errand", "private")) }
    }

    private val choices = """{"actionId":"33333333-3333-4333-8333-333333333333","turnId":"44444444-4444-4444-8444-444444444444",
        "generation":2,"contentDigest":"${"a".repeat(64)}","expiresAtMs":1000,
        "content":{"kind":"choices","title":"Tonight's films","items":[{"id":"1","title":"Arrival","detail":"A linguist meets visitors."},{"id":"2","title":"Heat","detail":"A crew and a detective."}]},
        "credits":[]}"""

    private val status = """{"turnId":"44444444-4444-4444-8444-444444444444","generation":2,"state":"shown","surfacePlatform":"macos","privacy":"shared_room"}"""

    private fun withStatus(status: String?): String = base.format("null").replace("\"speech\":null", "\"speech\":null,\"status\":${status ?: "null"}")
        .replace("\"operation\":\"display\"", "\"operation\":\"status\"")

    @Test
    fun decodesTurnStatusWhenPresentToleratesItsAbsenceAndRejectsUnknownShapes() {
        val shown = NativeEvent.decode(withStatus(status).toByteArray()).status!!
        assertEquals("shown", shown.state)
        assertEquals("macos", shown.surfacePlatform)
        assertEquals("shared_room", shown.privacy)
        assertEquals(2L, shown.generation)
        val unnamed = NativeEvent.decode(withStatus(status.replace("\"macos\"", "null").replace("shown", "waiting")).toByteArray()).status!!
        assertEquals("waiting", unnamed.state)
        assertNull(unnamed.surfacePlatform)
        // Absent, null and disconnected all read as no status; the operation name alone is accepted.
        assertNull(NativeEvent.decode(base.format("null").toByteArray()).status)
        assertNull(NativeEvent.decode(withStatus(null).toByteArray()).status)
        assertNull(NativeEvent.decode(withStatus(status).replace("\"connected\":true", "\"connected\":false").toByteArray()).status)
        assertEquals("done", NativeEvent.decode(withStatus(status.replace("shown", "done")).toByteArray()).status!!.state)
        assertThrows(Exception::class.java) { NativeEvent.decode(withStatus(status.replace("shown", "finished")).toByteArray()) }
        assertThrows(Exception::class.java) { NativeEvent.decode(withStatus(status.replace("macos", "watch")).toByteArray()) }
        assertThrows(Exception::class.java) { NativeEvent.decode(withStatus(status.replace("shared_room", "sensitive")).toByteArray()) }
        assertThrows(Exception::class.java) { NativeEvent.decode(withStatus(status.replace("\"generation\":2", "\"generation\":0")).toByteArray()) }
        assertThrows(Exception::class.java) { NativeEvent.decode(withStatus(status.replace(",\"privacy\":\"shared_room\"", "")).toByteArray()) }
    }

    @Test
    fun decodesChoiceCardsWithTwoToEightDistinctOptionsAndNoCredits() {
        val card = NativeEvent.decode(base.format(choices).toByteArray()).display!!
        val content = card.content as DisplayContent.Choices
        assertEquals("Tonight's films", content.title)
        assertEquals(listOf(Choice("1", "Arrival", "A linguist meets visitors."), Choice("2", "Heat", "A crew and a detective.")), content.items)
        assertNull(NativeEvent.decode(base.format("null").toByteArray()).display)
        val one = choices.replace(""",{"id":"2","title":"Heat","detail":"A crew and a detective."}""", "")
        assertThrows(Exception::class.java) { NativeEvent.decode(base.format(one).toByteArray()) }
        val nine = choices.replace("""{"id":"2","title":"Heat","detail":"A crew and a detective."}""",
            (2..9).joinToString(",") { """{"id":"$it","title":"Film $it","detail":""}""" })
        assertThrows(Exception::class.java) { NativeEvent.decode(base.format(nine).toByteArray()) }
        assertThrows(Exception::class.java) { NativeEvent.decode(base.format(choices.replace("\"id\":\"2\"", "\"id\":\"1\"")).toByteArray()) }
        assertThrows(Exception::class.java) { NativeEvent.decode(base.format(choices.replace("\"title\":\"Heat\"", "\"title\":\" \"")).toByteArray()) }
        assertThrows(Exception::class.java) { NativeEvent.decode(base.format(choices.replace("\"detail\":\"A crew and a detective.\"", "")).toByteArray()) }
        assertThrows(Exception::class.java) { NativeEvent.decode(base.format(choices.replace("\"credits\":[]", "\"credits\":[[{\"kind\":\"text\",\"text\":\"x\"}]]")).toByteArray()) }
        assertThrows(Exception::class.java) { NativeEvent.decode(base.format(choices.replace("\"kind\":\"choices\"", "\"kind\":\"menu\"")).toByteArray()) }
    }

    /**
     * A fresh enrollment asks for the newest profile; an installation the owner
     * approved earlier keeps its own, and the challenge carries that one. A build
     * that did not know the new word would refuse to connect the moment the owner
     * reapproved this device, so every published rung still decodes.
     */
    @Test
    fun everyPublishedApprovalRungStillDecodes() {
        assertEquals("native-audience-v6", NativeEvent.APPROVAL)
        assertEquals(
            listOf("native-audience-v6", "native-voice-input-v5", "native-device-action-v4",
                "native-shared-speech-v3", "native-shared-display-v2"),
            NativeEvent.KNOWN_APPROVALS.toList(),
        )
        for (approval in NativeEvent.KNOWN_APPROVALS) {
            val event = NativeEvent.decode(
                base.format("null").replace("native-device-action-v4", approval).toByteArray())
            assertEquals(approval, event.descriptor!!.approval)
        }
        for (foreign in listOf("native-audience-v7", "native-display-v1")) {
            assertThrows(IllegalArgumentException::class.java) {
                NativeEvent.decode(base.format("null").replace("native-device-action-v4", foreign).toByteArray())
            }
        }
    }

    @Test
    fun approvalLinkCarriesTheDescriptorAsAnUnpaddedFragment() {
        val descriptor = Descriptor("11111111-1111-4111-8111-111111111111", "k", "android", "native-shared-speech-v3")
        val url = descriptor.approvalUrl("https://center.example/")
        val fragment = url.substringAfter("#descriptor=")
        assertEquals("https://center.example/settings/account/surfaces#descriptor=", url.substringBefore(fragment))
        assertEquals(descriptor.json(), String(java.util.Base64.getUrlDecoder().decode(fragment)))
    }

    @Test
    fun decodesPrivateCardsAndWaitingInvitationsOnlyWhileConnected() {
        val private = places.replace("\"expiresAtMs\":1000,", "\"expiresAtMs\":1000,\"privacy\":\"private\",")
        val event = NativeEvent.decode(base.format(private).toByteArray())
        assertEquals("private", event.display!!.privacy)
        assertEquals(true, event.display!!.private)
        assertEquals("shared_room", NativeEvent.decode(base.format(places).toByteArray()).display!!.privacy)
        assertThrows(IllegalArgumentException::class.java) {
            NativeEvent.decode(base.format(places.replace("\"expiresAtMs\":1000,", "\"expiresAtMs\":1000,\"privacy\":\"sensitive\",")).toByteArray())
        }
        val invitation = """{"id":"66666666-6666-4666-8666-666666666666","kind":"card","origin":"pin","privacy":"private","expiresAtMs":2000}"""
        val waiting = NativeEvent.decode(base.format("null").replace("\"speech\":null", "\"speech\":null,\"invitation\":$invitation")
            .replace("\"operation\":\"display\"", "\"operation\":\"invitation\"").toByteArray())
        assertEquals("pin", waiting.invitation!!.origin)
        assertEquals(2000L, waiting.invitation!!.expiresAtMs)
        val disconnected = NativeEvent.decode(base.format("null").replace("\"speech\":null", "\"speech\":null,\"invitation\":$invitation")
            .replace("\"connected\":true", "\"connected\":false").toByteArray())
        assertNull(disconnected.invitation)
        assertThrows(IllegalArgumentException::class.java) {
            NativeEvent.decode(base.format("null").replace("\"speech\":null", "\"speech\":null,\"invitation\":${invitation.replace("\"private\"", "\"shared_room\"")}").toByteArray())
        }
    }
}
