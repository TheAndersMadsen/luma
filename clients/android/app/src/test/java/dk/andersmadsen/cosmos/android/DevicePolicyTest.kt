package dk.andersmadsen.cosmos.android

import dk.andersmadsen.cosmos.android.action.DeclineReason
import dk.andersmadsen.cosmos.android.action.DeviceApp
import dk.andersmadsen.cosmos.android.action.DevicePolicy
import dk.andersmadsen.cosmos.android.action.HeldPolicy
import dk.andersmadsen.cosmos.android.action.Locator
import dk.andersmadsen.cosmos.android.action.MediaProviders
import dk.andersmadsen.cosmos.android.action.Operation
import dk.andersmadsen.cosmos.android.action.PlannedAction
import dk.andersmadsen.cosmos.android.action.Position
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class DevicePolicyTest {
    private val policy = DevicePolicy(
        hosts = setOf("github.com"),
        apps = listOf(DeviceApp("com.google.android.youtube", "YouTube")),
        route = true,
        providers = setOf("youtube"),
    )
    private val link = Operation.Open(Locator.Https("https://github.com/owner/repo/pull/412"), null, null, "PR 412")

    @Test
    fun opensOnlyTheHostsTheOwnerListedHere() {
        assertEquals(PlannedAction.OpenLink("https://github.com/owner/repo/pull/412"), policy.plan(link, DevicePolicy.PHONE))
        // The runtime said to open it; this phone's own copy did not list the host.
        val elsewhere = link.copy(locator = Locator.Https("https://example.com/x"))
        assertNull(policy.plan(elsewhere, DevicePolicy.PHONE))
        assertEquals(DeclineReason.NOT_PERMITTED, policy.refusal(elsewhere, DevicePolicy.PHONE))
        // An empty copy is an ordinary state: this device then opens nothing.
        assertNull(DevicePolicy().plan(link, DevicePolicy.PHONE))
        assertEquals(DeclineReason.NOT_PERMITTED, DevicePolicy().refusal(link, DevicePolicy.PHONE))
    }

    @Test
    fun refusesAnythingThatIsNotAPlainHttpsLink() {
        val userinfo = link.copy(locator = Locator.Https("https://user:secret@github.com/x"))
        assertNull(policy.plan(userinfo, DevicePolicy.PHONE))
        assertEquals(DeclineReason.UNRESOLVABLE, policy.refusal(userinfo, DevicePolicy.PHONE))
        val port = link.copy(locator = Locator.Https("https://github.com:8443/x"))
        assertEquals(DeclineReason.UNRESOLVABLE, policy.refusal(port, DevicePolicy.PHONE))
        val plain = link.copy(locator = Locator.Https("http://github.com/x"))
        assertEquals(DeclineReason.UNRESOLVABLE, policy.refusal(plain, DevicePolicy.PHONE))
        // A file under an owner root belongs to a desktop; this device has none.
        val file = link.copy(locator = Locator.File("repo", "src/main.rs"))
        assertEquals(DeclineReason.UNRESOLVABLE, policy.refusal(file, DevicePolicy.PHONE))
        // A version binds an open to bytes a phone would have to read itself.
        val versioned = link.copy(version = "7".repeat(64), position = Position.Line(12))
        assertNull(policy.plan(versioned, DevicePolicy.PHONE))
        assertEquals(DeclineReason.VERSION_CHANGED, policy.refusal(versioned, DevicePolicy.PHONE))
    }

    @Test
    fun opensOnlyTheApplicationsTheOwnerListedHere() {
        val app = Operation.Open(Locator.App("com.google.android.youtube"), null, null, "YouTube")
        assertEquals(PlannedAction.OpenApp("com.google.android.youtube", "YouTube"), policy.plan(app, DevicePolicy.PHONE))
        val other = Operation.Open(Locator.App("com.example.other"), null, null, "Other")
        assertNull(policy.plan(other, DevicePolicy.PHONE))
        assertEquals(DeclineReason.NOT_PERMITTED, policy.refusal(other, DevicePolicy.PHONE))
    }

    private val route = Operation.Route("place", "Restaurant Barr", "Strandgade 93", "55.673611", "12.596944")

    @Test
    fun routesOnlyWhereTheOwnerAllowedItAndOnlyWithMintedCoordinates() {
        assertEquals(PlannedAction.Navigate("55.673611", "12.596944", "Restaurant Barr"), policy.plan(route, DevicePolicy.PHONE))
        assertNull(policy.copy(route = false).plan(route, DevicePolicy.PHONE))
        assertEquals(DeclineReason.NOT_PERMITTED, policy.copy(route = false).refusal(route, DevicePolicy.PHONE))
        // Six fraction digits exactly: float formatting is what drifts, and this is hashed.
        assertNull(policy.plan(route.copy(lat = "55.6736"), DevicePolicy.PHONE))
        assertNull(policy.plan(route.copy(lng = "181.000000"), DevicePolicy.PHONE))
        assertTrue(DevicePolicy.coordinate("-0.000000", 90))
        assertTrue(DevicePolicy.coordinate("90.000000", 90))
        assertFalse(DevicePolicy.coordinate("90.000001", 90))
        assertFalse(DevicePolicy.coordinate("055.673611", 90))
    }

    private val play = Operation.Play("The Zone of Interest", "The Zone of Interest trailer", listOf("youtube"), "c".repeat(64))

    @Test
    fun playsOnlyTheProvidersTheOwnerAllowedAndOnlyOnTheTelevision() {
        assertEquals(
            PlannedAction.Play("youtube", "The Zone of Interest trailer", "The Zone of Interest", "c".repeat(64)),
            policy.plan(play, DevicePolicy.TV),
        )
        val netflix = play.copy(providers = listOf("netflix"))
        assertNull(policy.plan(netflix, DevicePolicy.TV))
        assertEquals(DeclineReason.NOT_PERMITTED, policy.refusal(netflix, DevicePolicy.TV))
    }

    @Test
    fun refusesWhatThisPlatformDoesNotDeclareAtAll() {
        // The phone never plays and the television never opens or routes.
        assertNull(policy.plan(play, DevicePolicy.PHONE))
        assertEquals(DeclineReason.NO_HANDLER, policy.refusal(play, DevicePolicy.PHONE))
        assertNull(policy.plan(link, DevicePolicy.TV))
        assertEquals(DeclineReason.NO_HANDLER, policy.refusal(link, DevicePolicy.TV))
        assertNull(policy.plan(route, DevicePolicy.TV))
        assertEquals(DeclineReason.NO_HANDLER, policy.refusal(route, DevicePolicy.TV))
        // A command shape this build does not implement is refused, never guessed at.
        val run = Operation.Unsupported("run")
        assertNull(policy.plan(run, DevicePolicy.PHONE))
        assertEquals(DeclineReason.NO_HANDLER, policy.refusal(run, DevicePolicy.PHONE))
    }

    // ---------------------------------------------------------------------
    // The copy Cosmos delivers over the connection this device already holds
    // ---------------------------------------------------------------------

    private val surface = UUID.fromString("22222222-2222-4222-8222-222222222222")

    private val document = """{"version":1,"surfaceId":"$surface","approvalRevision":4,""" +
        """"actions":{"revision":2,"maximumClass":"shared_room",""" +
        """"open":{"hosts":["github.com"],"apps":[{"id":"com.google.android.youtube","label":"YouTube"}],"roots":[]},""" +
        """"route":{"app":"google_maps"},"play":{"providers":["youtube"]}}}"""

    /** What a snapshot would say about [body]; the digest and the length are of those exact bytes. */
    private fun named(
        body: String = document, surfaceId: UUID = surface, approvalRevision: Long = 4,
        actionsRevision: Long? = 2, commandsRevision: Long? = null,
        digest: String = DevicePolicy.digest(body.toByteArray()), byteLength: Int = body.toByteArray().size,
    ) = HeldPolicy(surfaceId, approvalRevision, actionsRevision, commandsRevision, digest, byteLength)

    @Test
    fun readsTheCopyCosmosDeliveredForThisInstallation() {
        val decoded = DevicePolicy.decode(document.toByteArray(), named())!!
        assertEquals(setOf("github.com"), decoded.hosts)
        assertEquals(listOf(DeviceApp("com.google.android.youtube", "YouTube")), decoded.apps)
        assertTrue(decoded.route)
        assertEquals(setOf("youtube"), decoded.providers)
        // What the Pixel is actually sent: it may route, and nothing else.
        val routing = """{"version":1,"surfaceId":"$surface","approvalRevision":4,""" +
            """"actions":{"revision":2,"maximumClass":"shared_room","route":{"app":"google_maps"}}}"""
        val only = DevicePolicy.decode(routing.toByteArray(), named(routing))!!
        assertTrue(only.route)
        assertTrue(only.hosts.isEmpty() && only.apps.isEmpty() && only.providers.isEmpty())
        // The provider id is the owner's; the package it maps to stays here.
        assertEquals(listOf("com.google.android.youtube.tv", "com.google.android.youtube"), MediaProviders.packages("youtube"))
        // Bytes are what they were said to be; the hex is the fleet's own.
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", DevicePolicy.digest(ByteArray(0)))
    }

    @Test
    fun holdsOnlyTheOwnersStatementAboutThisSurfaceAndThisApproval() {
        // Someone else's permission, and the owner's permission at another
        // approval, are both refused whole rather than half-held.
        assertNull(DevicePolicy.decode(document.toByteArray(), named(surfaceId = UUID.randomUUID())))
        assertNull(DevicePolicy.decode(document.toByteArray(), named(approvalRevision = 5)))
        // A section revision the snapshot did not name is a copy that drifted.
        assertNull(DevicePolicy.decode(document.toByteArray(), named(actionsRevision = 3)))
        assertNull(DevicePolicy.decode(document.toByteArray(), named(actionsRevision = null)))
        assertNull(DevicePolicy.decode(document.toByteArray(), named(commandsRevision = 1)))
        // And these have to be the exact bytes the snapshot named.
        assertNull(DevicePolicy.decode(document.toByteArray(), named(digest = "0".repeat(64))))
        assertNull(DevicePolicy.decode(document.toByteArray(), named(byteLength = document.toByteArray().size - 1)))
    }

    @Test
    fun refusesADocumentThatIsOutOfShapeAnywhereAtAll() {
        val refused = { body: String -> assertNull(body, DevicePolicy.decode(body.toByteArray(), named(body))) }
        // Half an allowlist is worse than none: every bound the runtime applied
        // when the owner saved this is applied again here, to the whole copy.
        refused(document.replace("\"github.com\"", (1..20).joinToString(",") { "\"host$it.example\"" }))
        refused(document.replace("\"github.com\"", "\"Not A Host\""))
        refused(document.replace("com.google.android.youtube", "com.example/../evil"))
        refused(document.replace("\"YouTube\"", "\"\""))
        refused(document.replace("\"youtube\"", "\"YouTube!\""))
        refused(document.replace("\"version\":1", "\"version\":2"))
        refused(document.replace("\"shared_room\"", "\"sensitive\""))
        refused(document.replace("\"label\":\"YouTube\"", "\"desktop\":\"youtube.desktop\""))
        refused("not json")
        assertNull(DevicePolicy.decode(ByteArray(0), named("")))
        val tooLong = "x".repeat(DevicePolicy.MAX_POLICY_BYTES + 1)
        assertNull(DevicePolicy.decode(tooLong.toByteArray(), named(tooLong)))
        // Only one route application exists; anything else is simply not a route.
        val other = document.replace("google_maps", "other_maps")
        assertFalse(DevicePolicy.decode(other.toByteArray(), named(other))!!.route)
    }

    @Test
    fun aDeviceHoldingNothingCarriesNothingOutAtAll() {
        // Disconnected, reapproved, or never allowed anything: it is the same
        // state, and in it every command is refused with a reason, never run.
        val nothing = DevicePolicy()
        assertTrue(nothing.isEmpty)
        for (platform in listOf(DevicePolicy.PHONE, DevicePolicy.TV)) {
            for (operation in listOf(link, route, play)) {
                assertNull(nothing.plan(operation, platform))
                assertNotNull(nothing.refusal(operation, platform))
            }
        }
        assertEquals(DeclineReason.NOT_PERMITTED, nothing.refusal(link, DevicePolicy.PHONE))
        assertEquals(DeclineReason.NOT_PERMITTED, nothing.refusal(route, DevicePolicy.PHONE))
        assertEquals(DeclineReason.NOT_PERMITTED, nothing.refusal(play, DevicePolicy.TV))
    }
}
