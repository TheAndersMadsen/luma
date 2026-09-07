import Foundation
import XCTest
@testable import CosmosMac

/// What a person reads and what a key does while a task or a ceremony is on
/// screen. Every sentence comes from the strings file, and the ceremony is
/// answered only by a deliberate press.
@MainActor
final class TaskCardStateTests: XCTestCase {
    private static let request: ConfirmationRequest = {
        try! ConfirmationRequest(
            grantID: UUID(uuidString: "e5aa0000-0000-4000-8000-000000000001")!,
            actionID: UUID(uuidString: "6a1fa0f2-0000-4000-8000-000000000003")!,
            turnID: UUID(uuidString: "9c02a0f2-0000-4000-8000-000000000004")!,
            generation: 7,
            description: try! ActionDescription(verb: "run", subject: "Project tests",
                                                deviceKind: "macos",
                                                effect: "changes files in that project",
                                                privacyClass: "private"),
            descriptionDigest: "5630269f110ea730effc829a754c9ecb27e240f2a7a95a6b433c866f05ab906c",
            risk: .high, attestation: .deviceOwnerAuth, privacy: "private",
            expiresAtMs: 1_757_259_860_000
        )
    }()

    // MARK: The task card

    func testEveryStateMapsToTheStringsFile() throws {
        let now: Int64 = 1_757_259_830_000
        XCTAssertNil(TaskCard.card(.none, now: now), "a quiet panel shows no card at all")

        let ready = try XCTUnwrap(TaskCard.card(.ready, now: now))
        XCTAssertEqual(ready.state, Words.waitingForDevice)
        XCTAssertEqual(ready.sentence, Words.taskWaiting)
        XCTAssertFalse(ready.canCancel)

        let confirming = try XCTUnwrap(TaskCard.card(.confirming, now: now))
        XCTAssertEqual(confirming.state, Words.waitingForYou)

        let working = try XCTUnwrap(TaskCard.card(
            .working(label: "Project tests", startedAtMs: now - 14_400, cancellable: true), now: now))
        XCTAssertEqual(working.state, Words.working)
        XCTAssertEqual(working.sentence, "Running Project tests")
        XCTAssertEqual(working.elapsed, "0:14")
        XCTAssertTrue(working.canCancel)

        let done = try XCTUnwrap(TaskCard.card(
            TaskCard.finished(label: "Project tests", exitCode: 0, durationMs: 61_000), now: now))
        XCTAssertEqual(done.state, Words.completed)
        XCTAssertEqual(done.sentence, "Project tests finished after 1 minute 1 second.")
        XCTAssertEqual(done.detail, "It ended without errors.")
        XCTAssertFalse(done.canCancel, "a finished task has nothing to cancel")

        let unknown = try XCTUnwrap(TaskCard.card(.cannotConfirm, now: now))
        XCTAssertEqual(unknown.state, Words.cannotConfirm)
        XCTAssertEqual(unknown.sentence, Words.taskCannotConfirmDetail)

        // A refusal is "Not done", one sentence on what happened and one on what
        // to do, for every reason in the closed vocabulary.
        for reason in ActionRefusal.allCases {
            let card = try XCTUnwrap(TaskCard.card(TaskCard.refusal(reason), now: now))
            XCTAssertEqual(card.state, Words.notDone, reason.rawValue)
            XCTAssertEqual(card.sentence, Words.refusalHappened(reason))
            XCTAssertEqual(card.detail, Words.refusalNext(reason))
            XCTAssertTrue(card.sentence.hasSuffix("."), reason.rawValue)
            XCTAssertFalse(card.sentence.contains("_"), "the wire word never reaches a person")
            XCTAssertFalse(card.detail?.contains("_") ?? false)
            XCTAssertNil(card.elapsed)
        }

        // And for every way Cosmos can withdraw one.
        for reason in RevokedTask.Reason.allCases {
            let card = try XCTUnwrap(TaskCard.card(TaskCard.revoked(reason, label: "Project tests"),
                                                   now: now))
            XCTAssertEqual(card.state, Words.notDone, reason.rawValue)
            XCTAssertFalse(card.sentence.isEmpty)
            XCTAssertFalse(card.sentence.contains("_"))
        }
    }

    func testElapsedAndDurationReadAsAClockAndAsASentence() {
        XCTAssertEqual(TaskCard.elapsed(0), "0:00")
        XCTAssertEqual(TaskCard.elapsed(-5), "0:00")
        XCTAssertEqual(TaskCard.elapsed(14_400), "0:14")
        XCTAssertEqual(TaskCard.elapsed(247_000), "4:07")
        XCTAssertEqual(TaskCard.elapsed(3_750_000), "1:02:30")
        XCTAssertEqual(TaskCard.duration(1000), "1 second")
        XCTAssertEqual(TaskCard.duration(48_211), "48 seconds")
        XCTAssertEqual(TaskCard.duration(120_000), "2 minutes")
        XCTAssertEqual(TaskCard.duration(121_000), "2 minutes 1 second")
    }

    /// A non-zero exit code is the answer to "tell me what failed", not a failure.
    func testExitCodeOneIsCompletedNotAFailure() throws {
        let card = try XCTUnwrap(TaskCard.card(
            TaskCard.finished(label: "Project tests", exitCode: 1, durationMs: 48_211), now: 0))
        XCTAssertEqual(card.state, Words.completed)
        XCTAssertEqual(card.detail, "It ended with exit code 1.")
        XCTAssertFalse(card.isFailure)
        // A command with no exit code of its own was stopped, and says so.
        let stopped = try XCTUnwrap(TaskCard.card(
            TaskCard.finished(label: "Project tests", exitCode: nil, durationMs: 400), now: 0))
        XCTAssertEqual(stopped.state, Words.notDone)
    }

    // MARK: The ceremony

    func testTheCeremonyReadsInTheOwnersOwnWordsWithAVisibleCountdown() throws {
        let now = Self.request.expiresAtMs - 24_400
        let card = TaskCard.ceremony(Self.request, now: now)
        XCTAssertEqual(card.question, "Run Project tests on this Mac? It changes files in that project.")
        XCTAssertEqual(card.classLine, Words.ceremonyPrivate)
        XCTAssertEqual(card.confirm, "Confirm")
        XCTAssertEqual(card.decline, "Don't run")
        XCTAssertEqual(card.countdown, "25s left")
        XCTAssertTrue(card.canConfirm)
        XCTAssertFalse(card.question.contains("{"), "no wire shape reaches a person")
        XCTAssertFalse(card.question.contains("device_action"))

        // The countdown is bounded by the ceremony's own thirty seconds and
        // never runs negative.
        XCTAssertEqual(TaskCard.remainingSeconds(Self.request.expiresAtMs, now: Self.request.expiresAtMs), 0)
        XCTAssertEqual(TaskCard.remainingSeconds(Self.request.expiresAtMs,
                                                 now: Self.request.expiresAtMs + 5000), 0)
        XCTAssertEqual(TaskCard.remainingSeconds(Self.request.expiresAtMs,
                                                 now: Self.request.expiresAtMs - 120_000), 30)

        // A shared-room ceremony says nothing about privacy at all.
        let shared = try! ConfirmationRequest(
            grantID: Self.request.grantID, actionID: Self.request.actionID, turnID: Self.request.turnID,
            generation: 7,
            description: try! ActionDescription(verb: "open", subject: "PR 412", deviceKind: "macos",
                                                effect: "opens a page in your browser",
                                                privacyClass: "shared_room"),
            descriptionDigest: Self.request.descriptionDigest, risk: .low, attestation: .foregroundTap,
            privacy: "shared_room", expiresAtMs: Self.request.expiresAtMs)
        let sharedCard = TaskCard.ceremony(shared, now: now)
        XCTAssertNil(sharedCard.classLine)
        XCTAssertEqual(sharedCard.decline, "Don't open")

        // When this Mac cannot ask for the evidence, the card says so and the
        // confirm control is not offered at all.
        let blocked = TaskCard.ceremony(Self.request, now: now, blocked: Words.attestationUnsignedBuild)
        XCTAssertEqual(blocked.blocked, Words.attestationUnsignedBuild)
        XCTAssertFalse(blocked.canConfirm)
        XCTAssertEqual(blocked.decline, "Don't run", "declining is always one control away")
    }

    func testEscapeDismissesWithoutAnswering() {
        XCTAssertEqual(TaskCard.ceremonyKey(key: "\u{1b}", command: false), .dismiss)
        XCTAssertEqual(TaskCard.ceremonyKey(key: "\u{1b}", command: true), .dismiss,
                       "escape dismisses however it arrives, and answers nothing")
        XCTAssertEqual(TaskCard.ceremonyKey(key: "\r", command: true), .confirm)
        XCTAssertEqual(TaskCard.ceremonyKey(key: "\u{7f}", command: true), .decline)
        // A stray keypress must never resolve a permission for a device that can act.
        for key in ["\r", "y", "n", " ", "\t", "1", "\u{7f}"] {
            XCTAssertNil(TaskCard.ceremonyKey(key: key, command: false), key)
        }
        for key in ["y", "n", " ", "k", "."] {
            XCTAssertNil(TaskCard.ceremonyKey(key: key, command: true), key)
        }
        XCTAssertNil(TaskCard.ceremonyKey(key: "\r", command: true, option: true))
        XCTAssertNil(TaskCard.ceremonyKey(key: "\r", command: true, control: true))
        XCTAssertNil(TaskCard.ceremonyKey(key: "\r", command: true, shift: true))
    }

    /// The panel's own keyboard model, while a ceremony is up and while it is not.
    func testCloseIsNotCancelTask() {
        // Escape is not a Command combination at all: it reaches the window,
        // which hides the panel. Hiding is not cancelling and not answering.
        XCTAssertNil(PanelState.command(key: "\u{1b}", command: false, ceremony: true))
        XCTAssertNil(PanelState.command(key: "\u{1b}", command: false))
        XCTAssertEqual(PanelState.command(key: "w", command: true), .close)
        XCTAssertEqual(PanelState.command(key: "w", command: true, ceremony: true), .close,
                       "closing the panel stays closing the panel while a ceremony is up")
        XCTAssertEqual(PanelState.command(key: ".", command: true), .cancelTask)
        XCTAssertEqual(PanelState.command(key: ".", command: true, ceremony: true), .cancelTask)
        // The two combinations that answer a ceremony exist only while one is up.
        XCTAssertEqual(PanelState.command(key: "\r", command: true), .send)
        XCTAssertEqual(PanelState.command(key: "\r", command: true, ceremony: true), .confirmTask)
        XCTAssertNil(PanelState.command(key: "\u{7f}", command: true))
        XCTAssertEqual(PanelState.command(key: "\u{7f}", command: true, ceremony: true), .declineTask)
    }

    // MARK: The turn status the origin reads

    func testTurnStatusCoversTheActionStates() throws {
        func line(_ state: TurnState, platform: String?) throws -> StatusLine {
            PanelState.statusLine(try TurnStatus(turnID: UUID(uuidString: "22222222-2222-2222-2222-222222222222")!,
                                                 generation: 1, state: state,
                                                 surfacePlatform: platform, privacy: "shared_room"))
        }
        XCTAssertEqual(try line(.confirming, platform: "macos").title, Words.waitingForYou)
        XCTAssertEqual(try line(.confirming, platform: "linux").title, Words.waitingForDevice)
        XCTAssertEqual(try line(.acting, platform: "linux").detail, "Running on your Linux PC")
        XCTAssertEqual(try line(.done, platform: "android").detail, "Done on your phone")
        XCTAssertEqual(try line(.done, platform: "macos").detail, nil)
        let refused = try line(.refused, platform: "macos")
        XCTAssertEqual(refused.title, Words.notDone)
        // The origin never learns why: no reason, no class, no operation.
        XCTAssertEqual(refused.detail, Words.turnRefusedDetail)
        for reason in ActionRefusal.allCases {
            XCTAssertFalse(refused.detail?.contains(reason.rawValue) ?? false)
        }
        XCTAssertTrue(TurnState.allCases.count >= 10, "every state the library can send is named")
    }

    // MARK: Decoding what Cosmos sent

    func testTaskConfirmationAndRevokeDecodeFromTheSnapshotShape() throws {
        let task = """
        {"actionId":"6a1fa0f2-0000-4000-8000-000000000003",
         "turnId":"9c02a0f2-0000-4000-8000-000000000004","generation":7,"channel":"action.run",
         "contentDigest":"\(String(repeating: "b", count: 64))",
         "idempotencyKey":"\(String(repeating: "a", count: 64))",
         "operation":{"kind":"run","entryId":"project-tests","label":"Project tests",
           "entryDigest":"d286d467f47696ee524f6de46b9a17a772b655bc2ef3a29b935e3a2ed3185307",
           "argvDigest":"ac121b6624356d4df1a87d5d3ce7ea6bc1d516d138b8790b6f3f060f7f8fdc25",
           "budgetMs":900000,"mutates":true},
         "expiresAtMs":1757260000000,"reportByMs":1757260030000,"privacy":"shared_room"}
        """
        let decoded = try JSONDecoder().decode(DeviceTask.self, from: Data(task.utf8))
        XCTAssertEqual(decoded.channel, "action.run")
        XCTAssertEqual(decoded.operation.label, "Project tests")
        XCTAssertTrue(decoded.operation.mutates)
        XCTAssertEqual(decoded.operation.budgetMs, 900_000)

        // route and play decode so they can be refused with a reason; a kind
        // this Mac cannot name at all is rejected outright.
        let play = """
        {"actionId":"6a1fa0f2-0000-4000-8000-000000000003",
         "turnId":"9c02a0f2-0000-4000-8000-000000000004","generation":7,"channel":"action.play",
         "contentDigest":"\(String(repeating: "b", count: 64))",
         "idempotencyKey":"\(String(repeating: "a", count: 64))",
         "operation":{"kind":"play","title":"The Zone of Interest trailer",
           "query":"The Zone of Interest trailer","providers":["youtube"],
           "itemDigest":"\(String(repeating: "e", count: 64))"},
         "expiresAtMs":1757260000000,"reportByMs":1757260030000,"privacy":"shared_room"}
        """
        XCTAssertEqual(try JSONDecoder().decode(DeviceTask.self, from: Data(play.utf8)).operation,
                       .unsupported(kind: "play"))
        let nonsense = task.replacingOccurrences(of: "\"kind\":\"run\"", with: "\"kind\":\"exec\"")
        XCTAssertThrowsError(try JSONDecoder().decode(DeviceTask.self, from: Data(nonsense.utf8)))
        let badDigest = task.replacingOccurrences(of: String(repeating: "b", count: 64), with: "short")
        XCTAssertThrowsError(try JSONDecoder().decode(DeviceTask.self, from: Data(badDigest.utf8)))

        let confirmation = """
        {"grantId":"e5aa0000-0000-4000-8000-000000000001",
         "actionId":"6a1fa0f2-0000-4000-8000-000000000003",
         "turnId":"9c02a0f2-0000-4000-8000-000000000004","generation":7,
         "description":{"kind":"device_action","verb":"run","subject":"Project tests",
           "deviceKind":"macos","effect":"changes files in that project","class":"private"},
         "descriptionDigest":"5630269f110ea730effc829a754c9ecb27e240f2a7a95a6b433c866f05ab906c",
         "risk":"high","attestation":"device_owner_auth","privacy":"private",
         "expiresAtMs":1757259860000}
        """
        let request = try JSONDecoder().decode(ConfirmationRequest.self, from: Data(confirmation.utf8))
        XCTAssertEqual(request, Self.request)
        XCTAssertEqual(request.attestation, .deviceOwnerAuth)
        let weaker = confirmation.replacingOccurrences(of: "device_owner_auth", with: "a_tap")
        XCTAssertThrowsError(try JSONDecoder().decode(ConfirmationRequest.self, from: Data(weaker.utf8)))

        let revoked = try JSONDecoder().decode(
            RevokedTask.self,
            from: Data(#"{"actionId":"6a1fa0f2-0000-4000-8000-000000000003","reason":"preempted"}"#.utf8))
        XCTAssertEqual(revoked.reason, .preempted)
        XCTAssertThrowsError(try JSONDecoder().decode(
            RevokedTask.self,
            from: Data(#"{"actionId":"6a1fa0f2-0000-4000-8000-000000000003","reason":"because"}"#.utf8)))
    }

    // MARK: A build whose library cannot do this

    func testOlderLibraryWithoutTheOptionalSymbolsRefusesLoudly() async throws {
        let client = try MockClientBridge()
        // All four calls, or none: a build that cannot report must not run.
        client.capabilities = ClientCapabilities(targets: true, context: true, actions: false)
        let model = try await connected(client, policy: Self.workingPolicyFile())
        client.publish(ClientSnapshot(phase: .connected, task: try Self.task()))
        try await settle(model)
        XCTAssertEqual(model.taskCard?.state, Words.notDone)
        XCTAssertEqual(model.taskCard?.sentence, Words.actionsUnavailable)
        XCTAssertEqual(model.taskCard?.detail, Words.actionsUnavailableDetail)
        XCTAssertTrue(client.acknowledgedTasks.isEmpty, "nothing is bound that cannot be accounted for")
        XCTAssertTrue(client.reports.isEmpty, "and nothing is claimed either")
    }

    // MARK: The whole path, from act to report

    func testAMutatingCommandWithoutDeviceOwnerAuthIsRefusedBeforeAnythingIsSpawned() async throws {
        let client = try MockClientBridge()
        let model = try await connected(client, policy: Self.workingPolicyFile())
        client.publish(ClientSnapshot(phase: .connected, task: try Self.task()))
        try await settle(model)
        XCTAssertTrue(client.acknowledgedTasks.isEmpty,
                      "a command this Mac will not attempt is never acknowledged")
        XCTAssertEqual(client.reports.count, 1)
        XCTAssertEqual(client.reports.first?.0, ActionReport.refusal(.noAttestation))
        XCTAssertEqual(model.taskCard?.state, Words.notDone)
        XCTAssertEqual(model.taskCard?.sentence, Words.refusalHappened(.noAttestation))
    }

    func testTheCeremonyAnswerCarriesTheAttestationAndTheCommandThenRuns() async throws {
        let client = try MockClientBridge()
        let authenticator = StubAuthenticator()
        let model = try await connected(client, policy: Self.workingPolicyFile(),
                                        authenticator: authenticator)
        client.publish(ClientSnapshot(phase: .connected, confirmation: Self.request))
        XCTAssertEqual(model.ceremony?.question,
                       "Run Project tests on this Mac? It changes files in that project.")
        model.answerCeremony(granted: true)
        try await until { client.grants.count == 1 }
        XCTAssertEqual(client.grants.first?.0, true)
        XCTAssertEqual(client.grants.first?.1, .deviceOwnerAuth)
        XCTAssertEqual(authenticator.reasons.count, 1)

        client.publish(ClientSnapshot(phase: .connected, task: try Self.task()))
        try await settle(model)
        XCTAssertEqual(client.acknowledgedTasks.count, 1, "binding is acknowledged, once")
        XCTAssertEqual(client.reports.count, 1)
        XCTAssertEqual(client.reports.first?.0.outcome, .completed, "/usr/bin/true exits zero")
        XCTAssertEqual(model.taskCard?.state, Words.completed)
    }

    func testDecliningAnswersNoAndDismissingAnswersNothing() async throws {
        let client = try MockClientBridge()
        let model = try await connected(client, policy: Self.workingPolicyFile())
        client.publish(ClientSnapshot(phase: .connected, confirmation: Self.request))
        model.answerCeremony(granted: false)
        try await until { client.grants.count == 1 }
        XCTAssertEqual(client.grants.first?.0, false)
        XCTAssertNil(client.grants.first?.1, "a decline carries no attestation")
        XCTAssertEqual(model.taskCard?.sentence, Words.ceremonyDeclined)

        // A ceremony that goes away unanswered denies by fail-safe default, and
        // the panel says what happened rather than nothing.
        let second = try MockClientBridge()
        let dismissed = try await connected(second, policy: Self.workingPolicyFile())
        second.publish(ClientSnapshot(phase: .connected, confirmation: Self.request))
        second.publish(ClientSnapshot(phase: .connected))
        XCTAssertTrue(second.grants.isEmpty, "dismissal answers nothing at all")
        XCTAssertEqual(dismissed.taskCard?.sentence, Words.ceremonyExpired)
    }

    func testARepeatedCommandProducesNoSecondEffect() async throws {
        let client = try MockClientBridge()
        let model = try await connected(client, policy: Self.workingPolicyFile())
        // An open the policy refuses is reported once; a repeat with the same key
        // re-sends that report and re-verifies nothing again.
        let denied = try Self.task(operation: .open(locator: .https(url: "https://evil.example/x"),
                                                    version: nil, position: nil, label: "Page"),
                                   channel: "action.open")
        client.publish(ClientSnapshot(phase: .connected, task: denied))
        try await settle(model)
        XCTAssertEqual(client.reports.count, 1)
        XCTAssertEqual(client.reports.first?.0, ActionReport.refusal(.notPermitted))

        let repeated = try Self.task(operation: .open(locator: .https(url: "https://evil.example/x"),
                                                      version: nil, position: nil, label: "Page"),
                                     channel: "action.open",
                                     action: "6a1fa0f2-0000-4000-8000-000000000009")
        client.publish(ClientSnapshot(phase: .connected, task: repeated))
        try await settle(model)
        XCTAssertEqual(client.reports.count, 2, "the same report, sent again")
        XCTAssertEqual(client.reports.last?.0, ActionReport.refusal(.notPermitted))
        XCTAssertTrue(client.acknowledgedTasks.isEmpty)
    }

    /// Stopping is something this Mac can prove, so it is the one case where
    /// `cancelled` is honest. Both the owner's own Cancel task and a revoke from
    /// Cosmos take the same path.
    func testStoppingARunningCommandReportsCancelledAndSaysSo() async throws {
        for stoppedByCosmos in [false, true] {
            let client = try MockClientBridge()
            let policy = try Self.sleeperPolicyFile()
            let model = try await connected(client, policy: policy)
            let task = try Self.task(entry: Self.sleeper)
            // The whole path: the ceremony is answered here, with device-owner
            // authentication, before anything is spawned.
            client.publish(ClientSnapshot(phase: .connected, confirmation: Self.request))
            model.answerCeremony(granted: true)
            try await until { client.grants.count == 1 }
            client.publish(ClientSnapshot(phase: .connected, task: task))
            try await until { model.canCancelTask }
            XCTAssertEqual(client.acknowledgedTasks.count, 1)
            XCTAssertEqual(model.taskCard?.state, Words.working)
            XCTAssertEqual(model.taskCard?.sentence, "Running Long task")
            XCTAssertTrue(model.taskCard?.canCancel ?? false)

            if stoppedByCosmos {
                client.publish(ClientSnapshot(phase: .connected, task: task,
                                              revoked: RevokedTask(actionID: task.actionID,
                                                                   reason: .preempted)))
            } else {
                model.cancelTask()
            }
            try await until { !model.canCancelTask }
            try await Task.sleep(for: .milliseconds(200))
            XCTAssertEqual(client.reports.count, 1)
            XCTAssertEqual(client.reports.first?.0.outcome, .cancelled)
            XCTAssertEqual(model.taskCard?.state, Words.notDone)
            XCTAssertEqual(model.taskCard?.sentence,
                           stoppedByCosmos ? Words.taskStoppedForNewRequest : Words.taskStopped("Long task"))
        }
    }

    func testAnInvitationForATaskIsPresenceWithNoContent() async throws {
        let client = try MockClientBridge()
        let model = try await connected(client, policy: try Self.workingPolicyFile())
        client.publish(ClientSnapshot(
            phase: .connected,
            waiting: WaitingReply(id: UUID(uuidString: "aaaa0000-0000-4000-8000-000000000001")!,
                                  kind: .task, origin: "pin", privacy: "shared_room",
                                  expiresAtMs: 1_757_260_000_000)))
        XCTAssertEqual(model.activity, .ready)
        XCTAssertEqual(model.taskCard?.state, Words.waitingForDevice)
        XCTAssertEqual(model.taskCard?.sentence, Words.taskWaiting)
        XCTAssertEqual(model.presence, .waiting)
        XCTAssertTrue(client.reports.isEmpty, "an invitation is not a command")
        client.publish(ClientSnapshot(phase: .connected))
        XCTAssertEqual(model.activity, .none)
    }

    func testNoOwnerPolicyIsSaidPlainlyAndRefusesEverything() async throws {
        let client = try MockClientBridge()
        let model = try await connected(client, policy: URL(fileURLWithPath: "/no/such/policy.json"))
        XCTAssertFalse(model.hasTaskPolicy)
        XCTAssertEqual(Words.noTaskPolicy, "No tasks are set up for this Mac.")
        client.publish(ClientSnapshot(phase: .connected, task: try Self.task()))
        try await settle(model)
        XCTAssertEqual(client.reports.first?.0, ActionReport.refusal(.notPermitted))
        XCTAssertTrue(client.acknowledgedTasks.isEmpty)
    }

    // MARK: Helpers

    /// A policy file naming one harmless entry, so the whole path can run in a
    /// test without touching anything of the owner's.
    static func workingPolicyFile() throws -> URL {
        let entry = CommandEntry(id: "project-tests", label: "Project tests",
                                 argv: ["/usr/bin/true"], cwd: "/usr/bin",
                                 mutates: true, budgetMs: 20_000)
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("cosmos-policy-\(UUID().uuidString).json")
        let file = """
        {"version":1,"open":{"hosts":["github.com"]},
         "commands":{"entries":[{"id":"\(entry.id)","label":"\(entry.label)",
          "argv":["/usr/bin/true"],"cwd":"/usr/bin","mutates":true,"budgetMs":20000}]}}
        """
        try Data(file.utf8).write(to: url)
        return url
    }

    /// One entry that runs long enough to be stopped mid-flight.
    static let sleeper = CommandEntry(id: "long-task", label: "Long task",
                                      argv: ["/bin/sleep", "60"], cwd: "/usr/bin",
                                      mutates: true, budgetMs: 60_000)

    static func sleeperPolicyFile() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("cosmos-policy-\(UUID().uuidString).json")
        try Data("""
        {"version":1,"commands":{"entries":[{"id":"long-task","label":"Long task",
          "argv":["/bin/sleep","60"],"cwd":"/usr/bin","mutates":true,"budgetMs":60000}]}}
        """.utf8).write(to: url)
        return url
    }

    static func task(operation: DeviceOperation? = nil, channel: String = "action.run",
                     action: String = "6a1fa0f2-0000-4000-8000-000000000003",
                     entry providedEntry: CommandEntry? = nil) throws -> DeviceTask {
        let entry = providedEntry ?? CommandEntry(id: "project-tests", label: "Project tests",
                                                  argv: ["/usr/bin/true"], cwd: "/usr/bin",
                                                  mutates: true, budgetMs: 20_000)
        let operation = operation ?? .run(entryID: entry.id, label: entry.label,
                                          entryDigest: entry.entryDigest, argvDigest: entry.argvDigest,
                                          budgetMs: entry.budgetMs, mutates: entry.mutates)
        return try DeviceTask(
            actionID: UUID(uuidString: action)!,
            turnID: UUID(uuidString: "9c02a0f2-0000-4000-8000-000000000004")!,
            generation: 7, channel: channel,
            contentDigest: String(repeating: "b", count: 64),
            idempotencyKey: String(repeating: "a", count: 64),
            operation: operation, expiresAtMs: 1_757_260_000_000, reportByMs: 1_757_260_030_000,
            privacy: "shared_room")
    }

    private func connected(_ client: MockClientBridge, policy: URL,
                           authenticator: StubAuthenticator? = nil) async throws -> ClientModel {
        addTeardownBlock { try? FileManager.default.removeItem(at: policy) }
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid",
                                authenticator: authenticator ?? StubAuthenticator(), policyURL: policy)
        model.prepare()
        try await until { !model.busy && model.descriptor != nil }
        model.connect()
        try await until { !model.busy && model.snapshot.phase == .connected }
        return model
    }

    /// Waits for the task work the snapshot started to finish.
    private func settle(_ model: ClientModel) async throws {
        try await until { model.activity != .none && model.activity != .confirming }
        // The report is delivered right after the activity settles.
        try await Task.sleep(for: .milliseconds(120))
    }

    private func until(_ condition: () -> Bool, timeout: Duration = .seconds(10)) async throws {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while !condition() {
            guard ContinuousClock.now < deadline else { return XCTFail("condition never held") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }
}

/// Device-owner authentication without a prompt: the rule around it is what
/// these tests are about.
@MainActor
final class StubAuthenticator: DeviceOwnerAuthenticating {
    var unavailable: String?
    var succeeds = true
    private(set) var reasons: [String] = []

    func authenticate(reason: String) async -> Bool {
        reasons.append(reason)
        return succeeds
    }
}
