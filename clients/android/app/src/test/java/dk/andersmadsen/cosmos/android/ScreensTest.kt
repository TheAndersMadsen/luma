package dk.andersmadsen.cosmos.android

import dk.andersmadsen.cosmos.android.action.ActionOutcome
import dk.andersmadsen.cosmos.android.action.Attestation
import dk.andersmadsen.cosmos.android.action.Ceremony
import dk.andersmadsen.cosmos.android.action.CeremonyEvent
import dk.andersmadsen.cosmos.android.action.Confirmation
import dk.andersmadsen.cosmos.android.action.DeclineReason
import dk.andersmadsen.cosmos.android.action.Description
import dk.andersmadsen.cosmos.android.action.DevicePolicy
import dk.andersmadsen.cosmos.android.action.DeviceTask
import dk.andersmadsen.cosmos.android.action.Operation
import dk.andersmadsen.cosmos.android.action.Risk
import dk.andersmadsen.cosmos.android.ui.AssistantState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.UUID

class ScreensTest {
    private val descriptor = Descriptor("11111111-1111-4111-8111-111111111111", "k", "android", NativeEvent.APPROVAL)
    private val turn = UUID.fromString("44444444-4444-4444-8444-444444444444")
    private val card = DisplayCard(UUID.fromString("33333333-3333-4333-8333-333333333333"), turn, 2, "a".repeat(64), 1000, DisplayContent.Text("An answer."))

    @Test
    fun choosesSetupApproveOrSessionFromTheInstallationState() {
        assertEquals(Screen.SETUP, SurfaceState().screen())
        assertEquals(Screen.SETUP, SurfaceState(phase = Phase.PREPARING).screen())
        assertEquals(Screen.APPROVE, SurfaceState(phase = Phase.PREPARED, descriptor = descriptor).screen())
        assertEquals(Screen.SESSION, SurfaceState(phase = Phase.PREPARED, descriptor = descriptor, approved = true).screen())
        assertEquals(Screen.SESSION, SurfaceState(phase = Phase.CONNECTED, descriptor = descriptor).screen())
        assertEquals(Screen.APPROVE, SurfaceState(phase = Phase.BLOCKED, descriptor = descriptor).screen())
    }

    @Test
    fun reportsConnectedReconnectingOrDisconnected() {
        assertEquals(SessionStatus.CONNECTED, SurfaceState(phase = Phase.CONNECTED, connectionWanted = true).sessionStatus())
        assertEquals(SessionStatus.RECONNECTING, SurfaceState(phase = Phase.PREPARED, needsReconnect = true, connectionWanted = true).sessionStatus())
        assertEquals(SessionStatus.DISCONNECTED, SurfaceState(phase = Phase.PREPARED, descriptor = descriptor).sessionStatus())
        assertEquals("Reconnecting…", SessionStatus.RECONNECTING.label)
    }

    @Test
    fun mirrorsPlaybackAndCommandsOnTheWaveform() {
        assertEquals(AssistantState.SPEAKING, SurfaceState(speaking = true, busy = true).assistantState())
        assertEquals(AssistantState.THINKING, SurfaceState(busy = true, alert = true).assistantState())
        assertEquals(AssistantState.ERROR, SurfaceState(alert = true).assistantState())
        assertEquals(AssistantState.ERROR, SurfaceState(phase = Phase.BLOCKED).assistantState())
        assertEquals(AssistantState.IDLE, SurfaceState(phase = Phase.CONNECTED).assistantState())
    }

    @Test
    fun noticesFailuresPendingWorkAndFreshFeedbackButNotSteadyState() {
        val connected = SurfaceState(phase = Phase.CONNECTED, operation = "connect", message = "Cosmos confirmed the connection.")
        assertNull(connected.notice())
        assertNull(connected.copy(operation = "heartbeat").notice())
        assertNull(connected.copy(operation = "prepare", pendingOpen = true, hasPending = true).notice())
        assertEquals("Cosmos confirmed the connection.", connected.copy(alert = true).notice())
        assertEquals("Cosmos confirmed the connection.", connected.copy(phase = Phase.BLOCKED).notice())
        assertEquals("Cosmos confirmed the connection.", connected.copy(hasPending = true).notice())
        // An abandoned operation is the status line's business, so it adds no notice of its own.
        assertNull(connected.copy(hasUnknownOutcome = true).notice())
        assertEquals("Admitted.", connected.copy(operation = "send_text", message = "Admitted.").notice())
        assertEquals("Gone.", connected.copy(operation = "disconnect", message = "Gone.").notice())
    }

    @Test
    fun offersCancelOnlyWhileTheAdmissionIsTheFreshestSnapshot() {
        val admitted = SurfaceState(phase = Phase.CONNECTED, operation = "send_text", admission = Admission(turn, 1, false))
        assertTrue(admitted.offersCancel())
        assertFalse(admitted.copy(operation = "heartbeat").offersCancel())
        assertFalse(admitted.copy(busy = true).offersCancel())
        assertFalse(admitted.copy(admission = null).offersCancel())
    }

    @Test
    fun stagesTheTvFromItsOwnRequestThenTheReplyForThatTurn() {
        val connected = SurfaceState(phase = Phase.CONNECTED, descriptor = descriptor)
        assertEquals(TvStage.Idle, connected.tvStage(null))
        // Sending: Working until Cosmos admits the request as a new turn, whatever admission the connection already carried.
        val earlier = Admission(UUID.fromString("22222222-2222-4222-8222-222222222222"), 1, false)
        val request = Ask("how many goals has he scored this season?", turnBefore = earlier.turnId)
        assertEquals(TvStage.Working, connected.copy(admission = earlier).tvStage(request))
        assertEquals(TvStage.Working, connected.copy(admission = earlier, busy = true).tvStage(request))
        // Admitted: the transcript stays until the card or spoken reply for that turn arrives; an older card does not count.
        val admitted = connected.copy(admission = Admission(turn, 2, false), operation = "send_text")
        assertEquals(TvStage.Transcript(request.text), admitted.tvStage(request))
        val older = card.copy(actionId = UUID.fromString("77777777-7777-4777-8777-777777777777"), turnId = earlier.turnId)
        assertEquals(TvStage.Transcript(request.text), admitted.copy(display = older).tvStage(request))
        assertEquals(TvStage.Answer(card.actionId, "An answer.", "An answer.", card), admitted.copy(display = card).tvStage(request))
        val speech = SpeechReply(UUID.fromString("55555555-5555-4555-8555-555555555555"), turn, 3, "b".repeat(64), 1000, "Five goals.", "audio/mpeg", 10)
        assertEquals(TvStage.Answer(speech.actionId, "Five goals.", "Five goals."), admitted.copy(speech = speech).tvStage(request))
        // A send that settled without a new admission is dropped.
        assertEquals(TvStage.Idle, connected.copy(admission = earlier, sends = 1).tvStage(request))
    }

    @Test
    fun captionsCurrentRepliesButNeverPrivateCardsOrDismissedOnes() {
        val connected = SurfaceState(phase = Phase.CONNECTED, descriptor = descriptor, admission = Admission(turn, 2, false))
        assertEquals(TvStage.Answer(card.actionId, "An answer.", "An answer.", card), connected.copy(display = card).tvStage(null))
        assertEquals(TvStage.Idle, connected.copy(display = card).tvStage(null, dismissed = card.actionId))
        assertEquals(TvStage.Idle, connected.copy(display = card.copy(privacy = "private")).tvStage(null))
        assertEquals(TvStage.Transcript("q"), connected.copy(display = card.copy(privacy = "near_user")).tvStage(Ask("q", null)))
        // Place cards caption their query; the list and credits wait in the paged view.
        val places = card.copy(content = DisplayContent.Places("Café", listOf(PlaceItem("one", "Café", "1 Main Street", null)), emptyList()))
        val stage = connected.copy(display = places).tvStage(null) as TvStage.Answer
        assertEquals("Café", stage.caption)
        assertEquals("Café\n\n1. Café\n1 Main Street", stage.full)
        // Housekeeping commands do not stage anything: a busy connection with no request stays idle.
        assertEquals(TvStage.Idle, connected.copy(busy = true).tvStage(null))
    }

    @Test
    fun speaksTheStatusVocabularyWithoutAnErrorTone() {
        fun status(state: String, platform: String?) = TurnStatus(turn, 1, state, platform, "shared_room")
        assertEquals("Working", status("working", null).line())
        assertEquals("Working", status("working", "macos").line())
        assertEquals("Waiting for a device", status("waiting", null).line())
        assertEquals("Waiting for your Mac", status("waiting", "macos").line())
        assertEquals("Shown on your Mac", status("shown", "macos").line())
        assertEquals("Spoken on your Mac", status("spoken", "macos").line())
        assertEquals("Shown on your Linux PC", status("shown", "linux").line())
        assertEquals("Shown on your phone", status("shown", "android").line())
        assertEquals("Spoken on your TV", status("spoken", "android_tv").line())
        assertEquals("Shown on your browser", status("shown", "browser").line())
        assertEquals("Spoken on your Ai Pin", status("spoken", "pin").line())
        assertEquals("Shown on a device", status("shown", null).line())
        assertEquals("Nowhere to show it", status("nowhere", null).line())
        assertEquals("Cannot confirm", status("unknown", "macos").line())
        // One state word and one short sentence; never two sentences under the line.
        assertEquals("That request was not sent again.", status("unknown", null).detail())
        assertEquals(1, CANNOT_CONFIRM_DETAIL.count { it == '.' })
        assertNull(status("shown", "macos").detail())
        assertNull(deviceName("watch"))
    }

    @Test
    fun namesTheAttachedScreenAndSaysNothingAtAllWhenThereIsNone() {
        val attached = AssistContext.Attached(ScreenContext("Gmail", "com.google.android.gm", "Subject: Invoice"))
        assertEquals("Using: Gmail screen", attached.chipLabel())
        // Nothing attached is said by the chip being absent, not by a sentence about
        // why: a locked screen, a screen the system offered nothing from and a chip
        // the owner took off are one and the same, because nothing travels either way.
        assertNull(AssistContext.Pending.chipLabel())
        assertNull(AssistContext.Removed.chipLabel())
        assertNull(AssistContext.Locked.chipLabel())
        assertNull(AssistContext.Unavailable.chipLabel())
        assertNull(AssistContext.NoRole.chipLabel())
    }

    @Test
    fun offersPlainDestinationsAndSendsNoTargetForThePhone() {
        assertEquals("", Destination.PHONE.target)
        assertEquals(listOf("This phone", "Mac", "Linux PC", "TV", "Browser"), Destination.entries.map { it.label })
        assertEquals(listOf("", "macos", "linux", "android_tv", "browser"), Destination.entries.map { it.target })
        assertEquals(Destination.MAC, Destination.forTarget("macos"))
        assertEquals(Destination.PHONE, Destination.forTarget(""))
        assertEquals(Destination.PHONE, Destination.forTarget("pin"))
    }

    @Test
    fun stagesChoicesOnTheTvUntilBackOrPrivacySendsThemAway() {
        val items = listOf(Choice("1", "Arrival", "A linguist meets visitors."), Choice("2", "Heat", "A crew and a detective."))
        val choices = card.copy(content = DisplayContent.Choices("Tonight's films", items))
        val connected = SurfaceState(phase = Phase.CONNECTED, descriptor = descriptor, admission = Admission(turn, 2, false), display = choices)
        assertEquals(TvStage.Choices(choices.actionId, "Tonight's films", items, choices), connected.tvStage(null))
        assertEquals(TvStage.Idle, connected.tvStage(null, dismissed = choices.actionId))
        assertEquals(TvStage.Idle, connected.copy(display = choices.copy(privacy = "near_user")).tvStage(null))
        // Choosing one is a request like any other: Working until Cosmos admits it as a new turn.
        assertEquals(TvStage.Working, connected.tvStage(Ask("Heat", turnBefore = turn)))
        assertEquals("Tonight's films\n\n1. Arrival\nA linguist meets visitors.\n\n2. Heat\nA crew and a detective.", choices.content.plainText())
        assertEquals("T\n\n1. A", DisplayContent.Choices("T", listOf(Choice("1", "A", ""))).plainText())
    }

    @Test
    fun reportsPresenceAsOneWordWithASettledLineToFadeOn() {
        val connected = SurfaceState(phase = Phase.CONNECTED, descriptor = descriptor)
        assertEquals(Presence("Connected", null, Tone.LIVE, true), connected.presence())
        assertEquals(Presence("Working", null, Tone.ACTIVE, false), connected.copy(busy = true).presence())
        // A request this phone just sent says Working, not the previous turn's outcome.
        val stale = TurnStatus(turn, 1, "shown", "macos", "shared_room")
        val after = connected.copy(status = stale, admission = Admission(turn, 1, false))
        assertEquals(Presence("Shown on your Mac", null, Tone.DONE, true), after.presence())
        assertEquals(Presence("Working", null, Tone.ACTIVE, false), after.presence(Ask("next", turnBefore = turn)))
        // Admitted as a new turn, but its own status has not arrived: still Working, never the old outcome.
        val next = UUID.fromString("66666666-6666-4666-8666-666666666666")
        assertEquals(Presence("Working", null, Tone.ACTIVE, false),
            after.copy(admission = Admission(next, 2, false)).presence(Ask("next", turnBefore = turn)))
        // A running turn never settles, so the line stays lit while it moves.
        val working = TurnStatus(turn, 1, "working", null, "shared_room")
        assertEquals(Presence("Working", null, Tone.ACTIVE, false), connected.copy(status = working).presence())
        val waiting = TurnStatus(turn, 1, "waiting", "macos", "shared_room")
        assertEquals(Presence("Waiting for your Mac", null, Tone.ACTIVE, false), connected.copy(status = waiting).presence())
        val unknown = TurnStatus(turn, 1, "unknown", null, "shared_room")
        assertEquals(Presence("Cannot confirm", CANNOT_CONFIRM_DETAIL, Tone.QUIET, true), connected.copy(status = unknown).presence())
        // Off the room the line is the connection itself, and the picker is not offered as a state.
        assertEquals(Presence("Reconnecting…", null, Tone.ACTIVE, false),
            SurfaceState(phase = Phase.PREPARED, descriptor = descriptor, connectionWanted = true, needsReconnect = true).presence())
        assertEquals(Presence("Disconnected", "Connect this phone to ask.", Tone.QUIET, true),
            SurfaceState(phase = Phase.PREPARED, descriptor = descriptor).presence())
        // An abandoned earlier request is the outcome of the last thing the owner did,
        // so it is said once in the same vocabulary and then fades, rather than standing
        // on the panel as a block of its own. Anything newer outranks it.
        assertEquals(Presence("Cannot confirm", CANNOT_CONFIRM_DETAIL, Tone.QUIET, true),
            connected.copy(hasUnknownOutcome = true).presence())
        assertEquals(Presence("Shown on your Mac", null, Tone.DONE, true),
            after.copy(hasUnknownOutcome = true).presence())
        assertEquals(Presence("Working", null, Tone.ACTIVE, false),
            connected.copy(hasUnknownOutcome = true, busy = true).presence())
        assertTrue(working.running())
        assertTrue(waiting.running())
        assertFalse(stale.running())
        assertFalse(unknown.running())
    }

    @Test
    fun showsTheTypedRequestAtOnceAndKeepsItUntilItsOwnReplyArrives() {
        val connected = SurfaceState(phase = Phase.CONNECTED, descriptor = descriptor)
        assertEquals(SheetBody.Empty, connected.sheetBody(null))
        val earlier = Admission(UUID.fromString("22222222-2222-4222-8222-222222222222"), 1, false)
        val ask = Ask("where is my package?", turnBefore = earlier.turnId)
        // The moment Send is pressed, before Cosmos has said anything at all.
        assertEquals(SheetBody.Now(ask.text), connected.copy(admission = earlier).sheetBody(ask))
        val admitted = connected.copy(admission = Admission(turn, 2, false), operation = "send_text")
        assertEquals(SheetBody.Now(ask.text), admitted.sheetBody(ask))
        // An older card is not this turn's answer and does not replace the line.
        val older = card.copy(actionId = UUID.fromString("77777777-7777-4777-8777-777777777777"), turnId = earlier.turnId)
        assertEquals(SheetBody.Now(ask.text), admitted.copy(display = older).sheetBody(ask))
        assertEquals(SheetBody.Reply(card), admitted.copy(display = card).sheetBody(ask))
        val speech = SpeechReply(UUID.fromString("55555555-5555-4555-8555-555555555555"), turn, 3, "b".repeat(64), 1000, "Tomorrow.", "audio/mpeg", 10)
        assertEquals(SheetBody.Spoken("Tomorrow."), admitted.copy(speech = speech).sheetBody(ask))
        // The send is over the moment the installation's completed-send count moves, whether the
        // command settled with no admission or the client refused it before it ever left.
        val over = connected.copy(admission = earlier, sends = ask.sendsBefore + 1)
        assertEquals(SheetBody.Empty, over.sheetBody(ask))
        assertTrue(over.sendSettled(ask))
        assertFalse(connected.copy(admission = earlier, busy = true).sendSettled(ask))
        // The status line stops saying Working the moment the request is over.
        assertEquals(Presence("Connected", null, Tone.LIVE, true), over.presence(ask))
        // A private card still belongs on the personal phone, unlike the TV.
        assertEquals(SheetBody.Reply(card.copy(privacy = "private")), connected.copy(display = card.copy(privacy = "private")).sheetBody(null))
        assertEquals(SheetBody.Note("Connect this phone to ask Cosmos something."), SurfaceState(descriptor = descriptor).sheetBody(null))
        assertEquals(SheetBody.Note("Cosmos is rejoining this phone."),
            SurfaceState(descriptor = descriptor, connectionWanted = true, needsReconnect = true).sheetBody(null))
    }

    /**
     * Before anything is asked, a person reads at most one short line. The status
     * line is that line; nothing else on a connected, idle panel is prose.
     */
    @Test
    fun aConnectedIdlePanelHasOneLineToReadAndNoNotice() {
        val idle = SurfaceState(phase = Phase.CONNECTED, descriptor = descriptor)
        assertEquals(Presence("Connected", null, Tone.LIVE, true), idle.presence())
        assertNull(idle.presence().detail)
        assertNull(idle.notice())
        assertEquals(SheetBody.Empty, idle.sheetBody(null))
        // The prompts are chips to tap, never sentences: each is one short line.
        assertTrue(suggestions(true).all { it.length <= 24 && !it.contains(". ") })
    }

    @Test
    fun offersThreePromptsAndOnlyOffersTheScreenOneWhereThereIsAScreen() {
        assertEquals(listOf("Find cafés near me", "Show my notes about…"), suggestions(false))
        assertEquals(listOf("Find cafés near me", "Show my notes about…", "What\'s on my screen?"), suggestions(true))
        // A prompt that trails off starts the field instead of being sent as it stands.
        assertTrue(isComplete("Find cafés near me"))
        assertTrue(isComplete("What\'s on my screen?"))
        assertFalse(isComplete("Show my notes about…"))
    }

    @Test
    fun keepsABlankMessageOutOfTheNotice() {
        val sent = SurfaceState(phase = Phase.CONNECTED, operation = "send_text", message = "")
        assertNull(sent.notice())
        assertNull(sent.copy(alert = true).notice())
    }

    @Test
    fun labelsTheServerByHost() {
        assertEquals("center.andersmadsen.dk", serverLabel("https://center.andersmadsen.dk/"))
        assertEquals("center.example:8443", serverLabel(" https://center.example:8443 "))
    }

    @Test
    fun pagesWholeLinesWithoutShrinking() {
        assertEquals(listOf(0..2, 3..5, 6..6), pageRanges(7, 3))
        assertEquals(listOf(0..3), pageRanges(4, 4))
        assertEquals(listOf(0..0, 1..1), pageRanges(2, 0))
        assertEquals(listOf(0..0), pageRanges(0, 3))
    }

    @Test
    fun namesTheCommandStatesInTheSameVocabulary() {
        val line = { state: String -> TurnStatus(turn, 2, state, "android", "shared_room").line() }
        assertEquals("Waiting for you on your phone", line("confirming"))
        assertEquals("Working", line("acting"))
        assertEquals("Completed", line("done"))
        // The origin is told a device did not do it, and never why.
        assertEquals("Not done", line("refused"))
        assertNull(TurnStatus(turn, 2, "refused", "android", "shared_room").detail())
        assertTrue(TurnStatus(turn, 2, "confirming", null, "shared_room").running())
        assertTrue(TurnStatus(turn, 2, "acting", null, "shared_room").running())
        assertFalse(TurnStatus(turn, 2, "done", null, "shared_room").running())
    }

    private val command = DeviceTask(
        actionId = UUID.fromString("66666666-6666-4666-8666-666666666666"), turnId = turn, generation = 7,
        channel = "action.route", contentDigest = "3".repeat(64), idempotencyKey = "a".repeat(64),
        operation = Operation.Route("places/x", "Restaurant Barr", "Strandgade 93", "55.673611", "12.596944"),
        expiresAtMs = 1_000, reportByMs = 2_000, privacy = "shared_room",
    )

    @Test
    fun theTaskCardFollowsTheCommandThisDeviceBound() {
        val running = SurfaceState(phase = Phase.CONNECTED, task = command, taskStartedAtMs = 1_000)
        val card = running.taskCard(15_000, DevicePolicy.PHONE)!!
        assertEquals("Working", card.state)
        assertEquals("Starting directions to Restaurant Barr", card.sentence)
        assertEquals("0:14", card.elapsed)
        assertTrue(card.canCancel)
        // Close hides the card; the command itself carries on.
        assertNull(running.copy(taskClosed = true).taskCard(15_000, DevicePolicy.PHONE))
        // Only the report may say what happened, and only what it observed.
        val unknown = running.copy(taskReport = ActionOutcome.route("com.google.android.apps.maps", launched = true, navigating = false))
        assertEquals("Cannot confirm", unknown.taskCard(15_000, DevicePolicy.PHONE)?.state)
        assertNull(unknown.taskCard(15_000, DevicePolicy.PHONE)?.elapsed)
        // A television says nothing at all about a refusal.
        val refused = running.copy(taskReport = ActionOutcome.refused(DeclineReason.NOT_PERMITTED))
        assertEquals("Not done", refused.taskCard(15_000, DevicePolicy.PHONE)?.state)
        assertNull(refused.taskCard(15_000, DevicePolicy.TV))
        // A television renders nothing above the shared class, command or card.
        assertNull(running.copy(task = command.copy(privacy = "private")).taskCard(15_000, DevicePolicy.TV))
        assertEquals("Working", running.copy(task = command.copy(privacy = "private")).taskCard(15_000, DevicePolicy.PHONE)?.state)
        assertEquals("this TV", deviceWord(DevicePolicy.TV))
        assertEquals("this phone", deviceWord(DevicePolicy.PHONE))
        // A device that holds nothing did not refuse this one thing: it has
        // been given nothing at all, and it says that instead.
        val nothingHeld = running.copy(taskReport = ActionOutcome.refused(DeclineReason.NOT_PERMITTED))
        assertEquals("Not done", nothingHeld.taskCard(15_000, DevicePolicy.PHONE)?.state)
        assertEquals(
            "Cosmos has not given this phone anything it may do yet.",
            nothingHeld.taskCard(15_000, DevicePolicy.PHONE)?.sentence,
        )
        assertEquals("Allow it in Center → Devices, then ask again.", nothingHeld.taskCard(15_000, DevicePolicy.PHONE)?.next)
        // Holding a copy that simply does not cover this is a different sentence.
        val holding = nothingHeld.copy(permission = DevicePolicy(route = true))
        assertEquals("This phone has not been allowed to do that.", holding.taskCard(15_000, DevicePolicy.PHONE)?.sentence)
        // A television still explains nothing at all, permission or not.
        assertNull(nothingHeld.taskCard(15_000, DevicePolicy.TV))
        // A ceremony on screen is the first thing the card is about.
        val confirmation = Confirmation(
            grantId = UUID.fromString("77777777-7777-4777-8777-777777777777"), actionId = command.actionId,
            turnId = turn, generation = 7,
            description = Description("open", "PR 412", "android", "It opens a link.", "shared_room"),
            descriptionDigest = "9".repeat(64), risk = Risk.MODERATE, attestation = Attestation.FOREGROUND_TAP,
            privacy = "shared_room", expiresAtMs = 30_000,
        )
        val asking = running.copy(ceremony = Ceremony.open(confirmation, 0))
        assertEquals("Waiting for you", asking.taskCard(15_000, DevicePolicy.PHONE)?.state)
        // Dismissed with Back, the sheet is gone and the command is still running.
        val dismissed = asking.copy(ceremony = asking.ceremony!!.on(CeremonyEvent.Back))
        assertEquals("Working", dismissed.taskCard(15_000, DevicePolicy.PHONE)?.state)
    }

    /**
     * The Shield is not reachable from this workstation, so the television's rule
     * is proved here: the answer, the question band, and at most one word or one
     * sentence beside them. Never a hint, never an explanation, never two joined.
     */
    @Test
    fun theTelevisionSaysOneWordAtMostAndNeverAHint() {
        val connected = SurfaceState(phase = Phase.CONNECTED, descriptor = descriptor)
        // Idle and connected, a television says nothing at all: no D-pad hint, no tagline.
        assertNull(connected.tvNotice(0, voiceInput = true))
        // The connection is its own single word.
        assertEquals("Reconnecting…",
            SurfaceState(phase = Phase.PREPARED, descriptor = descriptor, connectionWanted = true, needsReconnect = true).tvNotice(0, voiceInput = true))
        assertEquals("Disconnected", SurfaceState(phase = Phase.PREPARED, descriptor = descriptor).tvNotice(0, voiceInput = true))
        // A running command is its state word alone: the room is never told what it was.
        val running = connected.copy(task = command, taskStartedAtMs = 1_000)
        assertEquals("Working", running.tvNotice(15_000, voiceInput = true))
        assertFalse(running.tvNotice(15_000, voiceInput = true)!!.contains("Restaurant Barr"))
        assertFalse(running.tvNotice(15_000, voiceInput = true)!!.contains("·"))
        // A refusal is invisible on a shared screen, so the line goes back to nothing.
        assertNull(running.copy(taskReport = ActionOutcome.refused(DeclineReason.NOT_PERMITTED)).tvNotice(15_000, voiceInput = true))
        // A private command was never the television's to show, running or not.
        assertNull(running.copy(task = command.copy(privacy = "private")).tvNotice(15_000, voiceInput = true))
        // What is left is the one sentence the panel owes, and only that one.
        val failed = connected.copy(alert = true, operation = "send_text", message = explain("busy"))
        assertEquals("Cosmos is still on the last request. Wait a moment and try again.", failed.tvNotice(0, voiceInput = true))
        // An abandoned earlier request is history and is not announced to a room.
        assertNull(connected.copy(hasUnknownOutcome = true).tvNotice(0, voiceInput = true))
    }

    /**
     * A television has no keyboard, so speaking is the whole of asking here. When
     * the television publishes no voice input of its own there is nothing to press
     * and nothing to type, and the one line it is allowed says where the owner asks
     * instead. It is a line about the owner's other devices, never about a field.
     */
    @Test
    fun aTelevisionWithNoVoiceInputSaysWhereToAskInsteadOfOfferingAField() {
        val connected = SurfaceState(phase = Phase.CONNECTED, descriptor = descriptor)
        assertEquals(TV_NO_VOICE_INPUT, connected.tvNotice(0, voiceInput = false))
        assertEquals("This TV has no voice input. Ask from your phone or your computer.", TV_NO_VOICE_INPUT)
        assertEquals("Anything to type is entered in Center, on your phone or computer.", TV_TYPED_IN_CENTER)
        // Neither line offers this screen as the place: no field, no keyboard, and each
        // one names a device that has one instead of asking for the value here.
        for (line in listOf(TV_NO_VOICE_INPUT, TV_TYPED_IN_CENTER)) {
            for (word in listOf("field", "keyboard", "remote", "this tv,")) assertFalse(line.lowercase().contains(word))
            assertTrue(line.contains("your phone"))
        }
        assertTrue(TV_TYPED_IN_CENTER.contains("Center"))
        // It is still only ever one line: a command's state word and the connection
        // both come first, and the missing microphone waits behind them.
        assertEquals("Disconnected", SurfaceState(phase = Phase.PREPARED, descriptor = descriptor).tvNotice(0, voiceInput = false))
        assertEquals("Working", connected.copy(task = command, taskStartedAtMs = 1_000).tvNotice(15_000, voiceInput = false))
        assertEquals(
            "Cosmos is still on the last request. Wait a moment and try again.",
            connected.copy(alert = true, operation = "send_text", message = explain("busy")).tvNotice(0, voiceInput = false),
        )
    }

    /**
     * The one control on the stage. Asking is the last claim on it, and a
     * television that cannot listen offers nothing at all rather than a field:
     * there is no keyboard behind any of these states.
     */
    @Test
    fun theOneTelevisionControlOffersVoiceLastAndNothingWhenItCannotListen() {
        val connected = SurfaceState(phase = Phase.CONNECTED, descriptor = descriptor)
        assertEquals(TvControl.ASK, connected.tvControl(taskRunning = false, voiceInput = true))
        // No microphone on this television: the crescent has nothing to open.
        assertEquals(TvControl.NONE, connected.tvControl(taskRunning = false, voiceInput = false))
        // Cosmos cannot take a request right now, so neither can the microphone.
        assertEquals(TvControl.NONE, connected.copy(busy = true).tvControl(taskRunning = false, voiceInput = true))
        assertEquals(TvControl.NONE, connected.copy(hasPending = true).tvControl(taskRunning = false, voiceInput = true))
        // Everything with a claim on the control comes before asking, in this order.
        assertEquals(TvControl.RETRY, connected.copy(canRetry = true).tvControl(taskRunning = true, voiceInput = true))
        assertEquals(TvControl.CANCEL, connected.tvControl(taskRunning = true, voiceInput = true))
        val disconnected = SurfaceState(phase = Phase.PREPARED, descriptor = descriptor)
        assertEquals(TvControl.CONNECT, disconnected.tvControl(taskRunning = false, voiceInput = true))
        // Disconnected with nothing to connect: still never a field.
        assertEquals(TvControl.NONE, disconnected.copy(busy = true).tvControl(taskRunning = false, voiceInput = true))
    }

    @Test
    fun aStaleReportSaysTheCommandMovedOnAndIsNeverStyledAsAFailure() {
        // A report names the command it is about. One for a command Cosmos
        // already replaced closed nothing and claimed nothing, so it is said
        // plainly, offers no retry, and is not an error.
        assertEquals("Cosmos replaced that command before this phone could say what happened.", explain("stale_task"))
        assertFalse(isFailure("stale_task"))
        assertTrue(isFailure("no_task"))
        assertTrue(isFailure("invalid_signature"))
        // One sentence on what happened, one on what to do, nothing technical.
        assertEquals("This phone is not approved yet. Approve it in Center, then connect.", explain("denied"))
        assertEquals("Cosmos could not confirm that. Try again in a moment.", explain("something_new"))
        // It is said once, quietly, where the panel keeps what it has to say;
        // a report that landed says nothing at all.
        val stale = SurfaceState(phase = Phase.CONNECTED, operation = "report", message = explain("stale_task"))
        assertEquals(explain("stale_task"), stale.notice())
        assertNull(stale.copy(message = "").notice())
    }

    @Test
    fun flattensCardsToPlainLinesWithCreditTextOnly() {
        assertEquals("An answer.", card.content.plainText())
        val places = DisplayContent.Places("Café", listOf(PlaceItem("one", "Café", "1 Main Street", "https://maps.example/one")),
            listOf(listOf(CreditPart.Text("Credit: "), CreditPart.Link("Map", "https://credits.example"))))
        assertEquals("Café\n\n1. Café\n1 Main Street\n\nGoogle Maps · Credit: Map", places.plainText())
        assertEquals("Café\n\nNo matching places found.", DisplayContent.Places("Café", emptyList(), emptyList()).plainText())
    }
}
