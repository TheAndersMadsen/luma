import Combine
import Foundation
import XCTest
@testable import CosmosMac

private func fixtureDescriptor() throws -> PublicDescriptor {
    // SEC1 P-256 generator: public material, validated by the real descriptor.
    let hex = "046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"
    let bytes = stride(from: 0, to: hex.count, by: 2).map { offset in
        let start = hex.index(hex.startIndex, offsetBy: offset)
        return UInt8(hex[start..<hex.index(start, offsetBy: 2)], radix: 16)!
    }
    return try PublicDescriptor(
        enrollmentID: UUID(uuidString: "11111111-1111-1111-1111-111111111111")!,
        publicKeyBytes: Data(bytes)
    )
}

private func fixtureAdmission(duplicate: Bool = false) throws -> TextAdmission {
    try TextAdmission(turnID: UUID(uuidString: "22222222-2222-2222-2222-222222222222")!,
                      generation: 1, duplicate: duplicate)
}

private struct RawTransportFailure: Error, CustomStringConvertible, LocalizedError {
    var description: String { "raw-transport-detail-must-not-appear" }
    var errorDescription: String? { description }
}

@MainActor
private final class ResultGate<Value> {
    private var continuation: CheckedContinuation<Value, Never>?
    private var buffered: Value?
    func wait() async -> Value {
        if let buffered { return buffered }
        return await withCheckedContinuation { continuation = $0 }
    }
    func resolve(_ value: Value) {
        guard let pending = continuation else { buffered = value; return }
        continuation = nil
        pending.resume(returning: value)
    }
}

@MainActor
private final class MockClientBridge: ClientBridge {
    var snapshot: ClientSnapshot
    var onChange: ((ClientSnapshot) -> Void)?
    let descriptor: PublicDescriptor
    var prepareServers: [ServerEndpoint] = []
    var connectCalls = 0
    var sentTexts: [String] = []
    var retryCalls = 0
    var cancelledAdmissions: [TextAdmission] = []
    var visibilityReports: [Bool] = []
    var acknowledgedCards: [DisplayCard] = []
    var audioRequests: [SpeechReply] = []
    var acknowledgedSpeech: [SpeechReply] = []
    var speechAudioHandler: ((SpeechReply) async throws -> Data)?
    var disconnectCalls = 0
    var prepareHandler: ((ServerEndpoint) async throws -> PublicDescriptor)?
    var connectHandler: (() async throws -> Void)?
    var sendHandler: ((String) async throws -> TextAdmission)?
    var retryHandler: (() async throws -> Void)?
    var disconnectHandler: (() async -> Void)?

    init(snapshot: ClientSnapshot = ClientSnapshot()) throws {
        self.snapshot = snapshot
        descriptor = try fixtureDescriptor()
    }
    func publish(_ value: ClientSnapshot) {
        snapshot = value
        onChange?(value)
    }
    func prepare(server: ServerEndpoint) async throws -> PublicDescriptor {
        prepareServers.append(server)
        if let prepareHandler { return try await prepareHandler(server) }
        publish(ClientSnapshot(phase: .prepared))
        return descriptor
    }
    func connect() async throws {
        connectCalls += 1
        if let connectHandler { try await connectHandler(); return }
        publish(ClientSnapshot(phase: .connected))
    }
    func send(text: String) async throws -> TextAdmission {
        sentTexts.append(text)
        if let sendHandler { return try await sendHandler(text) }
        let admission = try fixtureAdmission()
        publish(ClientSnapshot(phase: .connected, admission: admission))
        return admission
    }
    func retryPending() async throws {
        retryCalls += 1
        if let retryHandler { try await retryHandler(); return }
        publish(ClientSnapshot(phase: .connected, admission: try fixtureAdmission(duplicate: true)))
    }
    func cancel(admission: TextAdmission) async throws {
        cancelledAdmissions.append(admission)
        publish(ClientSnapshot(phase: .connected))
    }
    func setVisible(_ visible: Bool) async throws {
        visibilityReports.append(visible)
        var next = snapshot
        next.visible = visible
        publish(next)
    }
    func acknowledge(display: DisplayCard) async throws {
        guard snapshot.display == display else { throw ClientFailure.connectionUnavailable }
        acknowledgedCards.append(display)
    }
    func speechAudio(for reply: SpeechReply) async throws -> Data {
        audioRequests.append(reply)
        if let speechAudioHandler { return try await speechAudioHandler(reply) }
        throw ClientFailure.connectionUnavailable
    }
    func acknowledgeSpeech(_ reply: SpeechReply) async throws {
        guard snapshot.speech == reply else { throw ClientFailure.connectionUnavailable }
        acknowledgedSpeech.append(reply)
    }
    func disconnect() async {
        disconnectCalls += 1
        if let disconnectHandler { await disconnectHandler(); return }
        publish(ClientSnapshot(phase: .disconnected))
    }
}

final class ClientModelTests: XCTestCase {
    @MainActor
    private func finished(_ model: ClientModel, file: StaticString = #filePath, line: UInt = #line) async {
        if !model.busy { return }
        let done = expectation(description: "The current model operation finishes")
        let subscription = model.$busy.first(where: { !$0 }).sink { _ in done.fulfill() }
        defer { subscription.cancel() }
        await fulfillment(of: [done], timeout: 2)
        XCTAssertFalse(model.busy, file: file, line: line)
    }

    @MainActor
    private func prepared(_ client: MockClientBridge) async -> ClientModel {
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid")
        model.prepare()
        await finished(model)
        XCTAssertNotNil(model.descriptor)
        return model
    }

    @MainActor
    func testEndpointNormalizesCaseDefaultPortAndRootSlash() throws {
        for input in ["https://CENTER.example.invalid", "HTTPS://CENTER.EXAMPLE.INVALID:443/", " \nhttps://center.example.invalid/\t"] {
            let endpoint = try ServerEndpoint(input)
            XCTAssertEqual(endpoint.origin, "https://center.example.invalid")
            XCTAssertEqual(endpoint.surfacesURL.absoluteString, "https://center.example.invalid/settings/account/surfaces")
        }
        XCTAssertEqual(try ServerEndpoint("https://CENTER.example.invalid:8443/").origin,
                       "https://center.example.invalid:8443")
    }

    @MainActor
    func testEndpointRejectsNonOriginsAndCredentials() {
        let invalid = [
            "", "center.example.invalid", "http://center.example.invalid", "wss://center.example.invalid",
            "https://", "https://user@center.example.invalid", "https://user:password@center.example.invalid",
            "https://center.example.invalid/path", "https://center.example.invalid//",
            "https://center.example.invalid?", "https://center.example.invalid?token=value",
            "https://center.example.invalid#", "https://center.example.invalid#fragment",
            "https://center.example.invalid:0", "https://center.example.invalid:65536",
            "https://center%2eexample.invalid", "https://center.example.invalid\\path",
            "https://center example.invalid", "https://" + String(repeating: "a", count: 256) + ".invalid",
        ]
        for input in invalid {
            XCTAssertThrowsError(try ServerEndpoint(input)) { error in
                XCTAssertEqual(error as? ClientFailure, .invalidServer)
            }
        }
    }

    @MainActor
    func testPrepareRequiresAnExplicitActionAndConnectBindsTheSelectedOrigin() async throws {
        let client = try MockClientBridge()
        let model = ClientModel(client: client, initialServerOrigin: "HTTPS://CENTER.EXAMPLE.INVALID:443/")
        XCTAssertTrue(client.prepareServers.isEmpty)
        XCTAssertEqual(client.connectCalls, 0)
        XCTAssertNil(model.publicDescriptorData())
        model.prepare()
        await finished(model)
        XCTAssertEqual(client.prepareServers, [try ServerEndpoint("https://center.example.invalid")])
        XCTAssertEqual(model.descriptor, client.descriptor)
        XCTAssertEqual(model.publicDescriptorData(), try client.descriptor.encoded())
        XCTAssertEqual(model.serverInput, "https://center.example.invalid")
        XCTAssertTrue(model.canConnect)
        model.serverInput = "https://other.example.invalid"
        XCTAssertFalse(model.canConnect)
        model.connect()
        XCTAssertEqual(client.connectCalls, 0)
        model.serverInput = "https://CENTER.example.invalid:443/"
        XCTAssertTrue(model.canConnect)
    }

    @MainActor
    func testInvalidEndpointNeverReachesTheBridge() throws {
        let client = try MockClientBridge()
        let model = ClientModel(client: client, initialServerOrigin: "https://user:password@center.example.invalid")
        model.prepare()
        XCTAssertTrue(client.prepareServers.isEmpty)
        XCTAssertFalse(model.busy)
        XCTAssertEqual(model.message, ClientFailure.invalidServer.message)
        XCTAssertNil(model.descriptor)
    }

    @MainActor
    func testPendingConnectedRequestBlocksFreshOperationsAndAllowsOnlyExplicitRetry() async throws {
        let client = try MockClientBridge()
        let model = await prepared(client)
        client.publish(ClientSnapshot(phase: .connected, hasPending: true, canRetry: true))
        model.draft = "A different request must wait"
        XCTAssertFalse(model.canPrepare)
        XCTAssertFalse(model.canConnect)
        XCTAssertFalse(model.canSend)
        XCTAssertFalse(model.canCancel)
        XCTAssertFalse(model.canEditServer)
        XCTAssertTrue(model.canRetryPending)
        model.prepare(); model.connect(); model.send(); model.cancel()
        XCTAssertEqual(client.prepareServers.count, 1)
        XCTAssertEqual(client.connectCalls, 0)
        XCTAssertTrue(client.sentTexts.isEmpty)
        XCTAssertTrue(client.cancelledAdmissions.isEmpty)
        model.retryPending()
        await finished(model)
        XCTAssertEqual(client.retryCalls, 1)
        XCTAssertTrue(client.sentTexts.isEmpty)
        XCTAssertEqual(model.draft, "A different request must wait")
        XCTAssertEqual(model.message, "Cosmos confirmed the pending operation. Its exact request was reused.")
    }

    @MainActor
    func testInitialStorageRecoveryDoesNotClaimAServerOperation() async throws {
        let client = try MockClientBridge(snapshot: ClientSnapshot(
            phase: .blocked, failure: .storageBlocked, canRetry: true))
        client.retryHandler = { client.publish(ClientSnapshot(phase: .disconnected)) }
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid")
        model.retryPending()
        await finished(model)
        XCTAssertNil(model.descriptor)
        XCTAssertEqual(client.connectCalls, 0)
        XCTAssertTrue(client.sentTexts.isEmpty)
        XCTAssertEqual(model.message, "Protected storage recovered. Prepare the installation again to continue.")
    }

    @MainActor
    func testRetryEligibilityComesFromTheBridgeRatherThanPendingAlone() throws {
        let client = try MockClientBridge(snapshot: ClientSnapshot(phase: .connected, hasPending: true))
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid")
        XCTAssertFalse(model.canRetryPending)
        model.retryPending()
        XCTAssertEqual(client.retryCalls, 0)
        XCTAssertFalse(model.busy)
    }

    @MainActor
    func testHistoricalUnknownOutcomeDoesNotBlockNewPublicText() async throws {
        let client = try MockClientBridge(snapshot: ClientSnapshot(phase: .connected, hasUnknownOutcome: true))
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid")
        model.draft = "A new public question"
        XCTAssertTrue(model.canSend)
        XCTAssertFalse(model.canRetryPending)
        model.send()
        await finished(model)
        XCTAssertEqual(client.sentTexts, ["A new public question"])
    }

    @MainActor
    func testRetainedOpenOrReconnectCanRecoverWithoutPreparingANewIdentity() async throws {
        for recovery in [ClientSnapshot(phase: .disconnected, hasPending: true, pendingOpen: true),
                         ClientSnapshot(phase: .connected, hasPending: true, needsReconnect: true)] {
            let client = try MockClientBridge()
            let model = await prepared(client)
            client.publish(recovery)
            model.draft = "Wait for connection recovery"
            XCTAssertTrue(model.canConnect)
            XCTAssertFalse(model.canPrepare)
            XCTAssertFalse(model.canSend)
            XCTAssertFalse(model.canEditServer)
            model.connect()
            await finished(model)
            XCTAssertEqual(client.connectCalls, 1)
            XCTAssertEqual(client.prepareServers.count, 1)
            XCTAssertTrue(model.canSend)
        }
    }

    @MainActor
    func testBlockedJournalMustBeRetriedBeforeRetainedConnectionRecovery() async throws {
        let client = try MockClientBridge()
        let model = await prepared(client)
        client.publish(ClientSnapshot(phase: .disconnected, hasPending: true, failure: .storageBlocked,
                                      pendingOpen: true, needsReconnect: true, canRetry: true))
        XCTAssertFalse(model.canConnect)
        XCTAssertTrue(model.canRetryPending)
        model.connect()
        XCTAssertEqual(client.connectCalls, 0)
        XCTAssertEqual(model.statusText, ClientFailure.storageBlocked.message)
    }

    @MainActor
    func testDraftValidationBoundsUTF8BytesAndRejectsEmptyWhitespaceAndNUL() throws {
        XCTAssertTrue(ClientModel.validText(String(repeating: "a", count: 4000)))
        XCTAssertTrue(ClientModel.validText(String(repeating: "😀", count: 1000)))
        let invalid = ["", " \n\t", "before\0after", String(repeating: "a", count: 4001),
                       String(repeating: "😀", count: 1000) + "a"]
        let client = try MockClientBridge(snapshot: ClientSnapshot(phase: .connected))
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid")
        for text in invalid {
            XCTAssertFalse(ClientModel.validText(text))
            model.draft = text
            XCTAssertFalse(model.canSend)
            model.send()
        }
        XCTAssertTrue(client.sentTexts.isEmpty)
        XCTAssertFalse(model.busy)
    }

    @MainActor
    func testSendingPreservesExactTextAndReportsAdmissionWithoutClaimingRendering() async throws {
        let client = try MockClientBridge(snapshot: ClientSnapshot(phase: .connected))
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid")
        model.draft = "  Public request with its exact whitespace\n"
        model.send()
        await finished(model)
        XCTAssertEqual(client.sentTexts, ["  Public request with its exact whitespace\n"])
        XCTAssertEqual(model.draft, "")
        XCTAssertEqual(model.snapshot.admission, try fixtureAdmission())
        XCTAssertEqual(model.message, "Request admitted by Cosmos. The response appears on the approved display it selects.")
        model.cancel()
        await finished(model)
        XCTAssertEqual(client.cancelledAdmissions, [try fixtureAdmission()])
        XCTAssertEqual(model.message, "Cancellation admitted by Cosmos. Check Center for the cleared display.")
    }

    @MainActor
    func testExactRetryNeverResendsAnEditedDraft() async throws {
        let client = try MockClientBridge(snapshot: ClientSnapshot(phase: .connected))
        client.sendHandler = { _ in
            client.publish(ClientSnapshot(phase: .connected, hasPending: true, canRetry: true))
            throw ClientFailure.uncertainRequest
        }
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid")
        model.draft = "Original uncertain request"
        model.send()
        await finished(model)
        XCTAssertEqual(model.draft, "Original uncertain request")
        model.draft = "New draft must not replace the retained request"
        model.retryPending()
        await finished(model)
        XCTAssertEqual(client.sentTexts, ["Original uncertain request"])
        XCTAssertEqual(client.retryCalls, 1)
        XCTAssertEqual(model.draft, "New draft must not replace the retained request")
    }

    @MainActor
    func testSuccessfulRetryClearsOnlyTheUneditedAdmittedDraft() async throws {
        let client = try MockClientBridge(snapshot: ClientSnapshot(phase: .connected))
        client.sendHandler = { _ in
            client.publish(ClientSnapshot(phase: .connected, hasPending: true, canRetry: true))
            throw ClientFailure.uncertainRequest
        }
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid")
        model.draft = "Exact pending draft"
        model.send()
        await finished(model)
        model.retryPending()
        await finished(model)
        XCTAssertEqual(client.sentTexts, ["Exact pending draft"])
        XCTAssertEqual(model.draft, "")
        XCTAssertEqual(model.snapshot.admission, try fixtureAdmission(duplicate: true))
    }

    @MainActor
    func testBusyFencePreventsDuplicateSendClicks() async throws {
        let client = try MockClientBridge(snapshot: ClientSnapshot(phase: .connected))
        let gate = ResultGate<TextAdmission>()
        let started = expectation(description: "One send reached the bridge")
        client.sendHandler = { _ in started.fulfill(); return await gate.wait() }
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid")
        model.draft = "Send this once"
        model.send(); model.send()
        XCTAssertTrue(model.busy)
        XCTAssertFalse(model.canSend)
        await fulfillment(of: [started], timeout: 2)
        XCTAssertEqual(client.sentTexts, ["Send this once"])
        gate.resolve(try fixtureAdmission())
        await finished(model)
    }

    @MainActor
    func testDisconnectCancelsAQueuedSendBeforeTheBridgeIsCalled() async throws {
        let client = try MockClientBridge(snapshot: ClientSnapshot(phase: .connected))
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid")
        model.draft = "This queued request is cancelled"
        model.send(); model.disconnect()
        await finished(model)
        XCTAssertTrue(client.sentTexts.isEmpty)
        XCTAssertEqual(client.disconnectCalls, 1)
        XCTAssertEqual(model.draft, "This queued request is cancelled")
        XCTAssertEqual(model.snapshot.phase, .disconnected)
    }

    @MainActor
    func testDuplicateDisconnectClicksDoNotStartAnotherBridgeOperation() async throws {
        let client = try MockClientBridge(snapshot: ClientSnapshot(phase: .connected))
        let gate = ResultGate<Void>()
        let started = expectation(description: "One disconnect reached the bridge")
        client.disconnectHandler = {
            started.fulfill()
            await gate.wait()
            client.publish(ClientSnapshot(phase: .disconnected))
        }
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid")
        model.disconnect(); model.disconnect()
        XCTAssertFalse(model.canDisconnect)
        await fulfillment(of: [started], timeout: 2)
        model.disconnect()
        XCTAssertEqual(client.disconnectCalls, 1)
        gate.resolve(())
        await finished(model)
        XCTAssertEqual(model.message, "Session disconnected. Owner approval remains in Center.")
    }

    @MainActor
    func testLatePrepareResultAfterDisconnectCannotRestoreDescriptorOrMessage() async throws {
        let client = try MockClientBridge()
        let gate = ResultGate<PublicDescriptor>()
        let started = expectation(description: "Prepare is in flight")
        let returned = expectation(description: "The cancelled prepare returns late")
        client.prepareHandler = { _ in
            client.publish(ClientSnapshot(phase: .preparing))
            started.fulfill()
            let value = await gate.wait()
            returned.fulfill()
            return value
        }
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid")
        model.prepare()
        await fulfillment(of: [started], timeout: 2)
        XCTAssertTrue(model.canDisconnect)
        model.disconnect()
        await finished(model)
        let disconnectedMessage = model.message
        gate.resolve(client.descriptor)
        await fulfillment(of: [returned], timeout: 2)
        XCTAssertNil(model.descriptor)
        XCTAssertNil(model.publicDescriptorData())
        XCTAssertNil(model.selectedServer)
        XCTAssertEqual(model.message, disconnectedMessage)
        XCTAssertEqual(model.snapshot.phase, .disconnected)
        XCTAssertFalse(model.busy)
    }

    @MainActor
    func testLateSendSuccessAfterDisconnectCannotClearDraftOrClaimAdmission() async throws {
        let client = try MockClientBridge(snapshot: ClientSnapshot(phase: .connected))
        let gate = ResultGate<TextAdmission>()
        let started = expectation(description: "Send is in flight")
        let returned = expectation(description: "The cancelled send returns late")
        client.sendHandler = { _ in
            started.fulfill()
            let value = await gate.wait()
            returned.fulfill()
            return value
        }
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid")
        model.draft = "Keep this draft after disconnect"
        model.send()
        await fulfillment(of: [started], timeout: 2)
        model.disconnect()
        await finished(model)
        let disconnectedMessage = model.message
        gate.resolve(try fixtureAdmission())
        await fulfillment(of: [returned], timeout: 2)
        XCTAssertEqual(model.draft, "Keep this draft after disconnect")
        XCTAssertEqual(model.message, disconnectedMessage)
        XCTAssertNil(model.snapshot.admission)
        XCTAssertEqual(model.snapshot.phase, .disconnected)
        XCTAssertFalse(model.busy)
    }

    @MainActor
    func testLateSendFailureCannotOverwriteDisconnectState() async throws {
        let client = try MockClientBridge(snapshot: ClientSnapshot(phase: .connected))
        let gate = ResultGate<Void>()
        let started = expectation(description: "Send is in flight")
        let returned = expectation(description: "The cancelled send fails late")
        client.sendHandler = { _ in
            started.fulfill()
            await gate.wait()
            returned.fulfill()
            throw RawTransportFailure()
        }
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid")
        model.draft = "A public question"
        model.send()
        await fulfillment(of: [started], timeout: 2)
        model.disconnect()
        await finished(model)
        let disconnectedMessage = model.message
        gate.resolve(())
        await fulfillment(of: [returned], timeout: 2)
        XCTAssertEqual(model.message, disconnectedMessage)
        XCTAssertEqual(model.snapshot.phase, .disconnected)
        XCTAssertFalse(model.busy)
    }

    @MainActor
    func testUIErrorsUseFixedMessagesRatherThanRawTransportErrors() async throws {
        let client = try MockClientBridge(snapshot: ClientSnapshot(phase: .connected))
        client.sendHandler = { _ in throw RawTransportFailure() }
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid")
        model.draft = "A public question"
        model.send()
        await finished(model)
        XCTAssertEqual(model.message, ClientFailure.connectionUnavailable.message)
        XCTAssertFalse(model.message.contains(RawTransportFailure().description))
        client.sendHandler = { _ in throw ClientFailure.approvalRequired }
        model.send()
        await finished(model)
        XCTAssertEqual(model.message, ClientFailure.approvalRequired.message)
        client.publish(ClientSnapshot(phase: .blocked, failure: .storageUnavailable))
        XCTAssertEqual(model.statusText, ClientFailure.storageUnavailable.message)
        model.exportFailed()
        XCTAssertEqual(model.message, "The public descriptor could not be saved. Choose another location and retry.")
    }

    func testApprovalLinkCarriesTheDescriptorAsAnUnpaddedFragment() throws {
        let server = try ServerEndpoint("https://center.example")
        let data = Data("{\"a\":1}".utf8)
        let url = try XCTUnwrap(server.approvalURL(descriptorData: data))
        XCTAssertEqual(url.absoluteString, "https://center.example/settings/account/surfaces#descriptor=eyJhIjoxfQ")
        XCTAssertNil(server.approvalURL(descriptorData: Data(repeating: 0x20, count: 1025)))
    }

    @MainActor
    func testDeliveredCardIsAcknowledgedOnceAndClearedWhenRetired() async throws {
        let client = try MockClientBridge(snapshot: ClientSnapshot(phase: .connected, visible: true))
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid")
        let card = try DisplayCard(
            actionID: UUID(uuidString: "33333333-3333-3333-3333-333333333333")!,
            turnID: UUID(uuidString: "44444444-4444-4444-4444-444444444444")!,
            generation: 2, contentDigest: String(repeating: "a", count: 64), expiresAtMs: 1_000,
            content: .places(query: "Café & Bakery", items: [
                PlaceItem(placeID: "place-one", name: "Café", address: "1 Main Street",
                          sourceURL: "https://www.google.com/maps/place/?q=cafe"),
            ], credits: [[.text("Credit: "), .link(text: "Map & Data", href: "https://credits.example/source")]])
        )
        client.publish(ClientSnapshot(phase: .connected, visible: true, display: card))
        XCTAssertEqual(model.display, card)
        // The view acknowledges after commit; a repeated appear never acknowledges twice.
        model.displayCommitted(card)
        model.displayCommitted(card)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(client.acknowledgedCards, [card])
        client.publish(ClientSnapshot(phase: .connected, visible: true))
        XCTAssertNil(model.display)
        // A card that is no longer current cannot be acknowledged late.
        model.displayCommitted(card)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(client.acknowledgedCards, [card])
        XCTAssertThrowsError(try DisplayCard(actionID: DisplayCard.nilUUID, turnID: card.turnID, generation: 1,
                                             contentDigest: card.contentDigest, expiresAtMs: 1, content: .text("x")))
    }

    @MainActor
    func testVisibilityReportsOnlyChangesAndFollowsReconnect() async throws {
        let client = try MockClientBridge()
        let model = await prepared(client)
        model.setVisible(true)
        model.setVisible(true)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(client.visibilityReports, [true])
        model.connect()
        await finished(model)
        XCTAssertEqual(client.visibilityReports, [true, true])
        XCTAssertTrue(model.statusText.contains("visible"))
        model.setVisible(false)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(client.visibilityReports, [true, true, false])
    }
}
