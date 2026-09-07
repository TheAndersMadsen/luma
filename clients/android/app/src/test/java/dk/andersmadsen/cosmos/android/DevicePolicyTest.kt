package dk.andersmadsen.cosmos.android

import dk.andersmadsen.cosmos.android.action.DeclineReason
import dk.andersmadsen.cosmos.android.action.DeviceApp
import dk.andersmadsen.cosmos.android.action.DevicePolicy
import dk.andersmadsen.cosmos.android.action.Locator
import dk.andersmadsen.cosmos.android.action.Operation
import dk.andersmadsen.cosmos.android.action.PlannedAction
import dk.andersmadsen.cosmos.android.action.Position
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

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

    @Test
    fun readsTheOwnersOwnCopyAndRefusesOneThatIsOutOfShape() {
        val file = """{"version":1,"open":{"hosts":["GitHub.com"],"apps":[{"id":"com.google.android.youtube","label":"YouTube"}]},
            "route":{"app":"google_maps"},"play":{"providers":["youtube"]}}"""
        val decoded = DevicePolicy.decode(file.toByteArray())
        assertEquals(setOf("github.com"), decoded.hosts)
        assertEquals(listOf(DeviceApp("com.google.android.youtube", "YouTube")), decoded.apps)
        assertTrue(decoded.route)
        assertEquals(setOf("youtube"), decoded.providers)
        // Half an allowlist is worse than none: an over-cap or malformed copy is empty.
        val toMany = """{"open":{"hosts":[${(1..20).joinToString(",") { "\"host$it.example\"" }}]}}"""
        assertTrue(DevicePolicy.decode(toMany.toByteArray()).isEmpty)
        assertTrue(DevicePolicy.decode("not json".toByteArray()).isEmpty)
        assertTrue(DevicePolicy.decode(ByteArray(0)).isEmpty)
        assertTrue(DevicePolicy.decode(ByteArray(DevicePolicy.MAX_FILE_BYTES + 1) { 'x'.code.toByte() }).isEmpty)
        // Only one route application exists; anything else is not a route.
        assertFalse(DevicePolicy.decode("""{"route":{"app":"other_maps"}}""".toByteArray()).route)
    }
}
