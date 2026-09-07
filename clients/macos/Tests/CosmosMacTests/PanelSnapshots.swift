import AppKit
import Foundation
import SwiftUI
import XCTest
@testable import CosmosMac

/// Renders the panel in the states a device action puts it in, for looking at.
///
/// It drives the real `ClientModel` and the real `AssistantPanel`: the ceremony
/// is answered, the command is actually spawned, and the card shows the clock
/// that command is running on. It is skipped unless `COSMOS_UX_SHOTS` names a
/// directory to write to, so the ordinary check neither slows down nor depends
/// on a window server.
@MainActor
final class PanelSnapshots: XCTestCase {
    func testRendersTheCeremonyAndTheRunningTask() async throws {
        guard let directory = ProcessInfo.processInfo.environment["COSMOS_UX_SHOTS"] else {
            throw XCTSkip("Set COSMOS_UX_SHOTS to a directory to write the panel screenshots.")
        }
        let output = URL(fileURLWithPath: directory, isDirectory: true)
        let client = try MockClientBridge()
        client.deliver(try Self.sleeperPolicy())
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid",
                                authenticator: StubAuthenticator())
        model.prepare()
        try await until { !model.busy && model.descriptor != nil }
        model.connect()
        try await until { !model.busy && model.snapshot.phase == .connected }
        model.setVisible(true)

        // The ceremony, with about two thirds of its window left.
        let expires = ClientModel.nowMs() + 21_000
        client.publish(ClientSnapshot(phase: .connected, visible: true,
                                      confirmation: try Self.request(expiresAtMs: expires)))
        try await Task.sleep(for: .milliseconds(200))
        try render(model, to: output.appendingPathComponent("ux-mac-confirm.png"))

        // Answering it with device-owner authentication, then the command itself.
        model.answerCeremony(granted: true)
        try await until { client.grants.count == 1 }
        client.publish(ClientSnapshot(phase: .connected, visible: true, task: try Self.task()))
        try await until { model.canCancelTask }
        // Long enough for the elapsed clock to be worth reading.
        try await Task.sleep(for: .seconds(14))
        try render(model, to: output.appendingPathComponent("ux-mac-task.png"))
        model.cancelTask()
        try await until { !model.canCancelTask }
    }

    /// The panel before anything is asked, and the same panel with a reply on
    /// it. The first is the whole point of the quiet panel: one line and a
    /// field, with the suggestions as chips under it.
    func testRendersTheQuietPanelAndAReply() async throws {
        guard let directory = ProcessInfo.processInfo.environment["COSMOS_UX_SHOTS"] else {
            throw XCTSkip("Set COSMOS_UX_SHOTS to a directory to write the panel screenshots.")
        }
        let output = URL(fileURLWithPath: directory, isDirectory: true)
        let client = try MockClientBridge()
        client.deliver(try Self.sleeperPolicy())
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid",
                                authenticator: StubAuthenticator())
        model.prepare()
        try await until { !model.busy && model.descriptor != nil }
        model.connect()
        try await until { !model.busy && model.snapshot.phase == .connected }
        model.setVisible(true)
        // "Connected" stands for a moment and then fades; the empty panel is
        // what is left after it.
        try await Task.sleep(for: .seconds(3))
        try render(model, to: output.appendingPathComponent("ux-mac-quiet-empty.png"))

        model.draft = "What's the weather in Copenhagen?"
        model.send()
        try await until { !model.busy }
        client.publish(ClientSnapshot(phase: .connected, visible: true, display: try Self.reply(),
                                      status: try Self.shownHere()))
        try await Task.sleep(for: .milliseconds(200))
        try render(model, to: output.appendingPathComponent("ux-mac-quiet-reply.png"))
    }

    /// The two listening indicators, as the owner sees them: the panel waiting
    /// for the phrase, with the two things about listening on a laptop said
    /// under it, and the same panel while it is recording what follows.
    func testRendersThePanelWhileListening() async throws {
        guard let directory = ProcessInfo.processInfo.environment["COSMOS_UX_SHOTS"] else {
            throw XCTSkip("Set COSMOS_UX_SHOTS to a directory to write the panel screenshots.")
        }
        let output = URL(fileURLWithPath: directory, isDirectory: true)
        let client = try MockClientBridge()
        let listener = StubWakeWordListener()
        let store = UserDefaults(suiteName: "cosmos.snapshot.\(UUID().uuidString)")
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid",
                                authenticator: StubAuthenticator(), listener: listener,
                                listeningStore: store ?? .standard)
        model.prepare()
        try await until { !model.busy && model.descriptor != nil }
        model.connect()
        try await until { !model.busy && model.snapshot.phase == .connected }
        model.setVisible(true)
        // "Connected" stands for a moment; the listening panel is what is left.
        try await Task.sleep(for: .seconds(3))

        model.setListening(true)
        listener.report(.started)
        try await Task.sleep(for: .milliseconds(300))
        try render(model, to: output.appendingPathComponent("ux-mac-listening.png"))

        listener.report(.heardPhrase)
        listener.report(.captureBegan)
        try await Task.sleep(for: .milliseconds(300))
        try render(model, to: output.appendingPathComponent("ux-mac-heard.png"))
        model.setListening(false)
    }

    /// One PNG of the panel exactly as the application draws it: the real
    /// SwiftUI view in a real window, cached to a bitmap, in the dark
    /// appearance the owner's Mac uses. `ImageRenderer` cannot rasterize the
    /// panel's scroll view, so this goes through AppKit's own drawing.
    private func render(_ model: ClientModel, to url: URL) throws {
        let hosting = NSHostingView(rootView: AssistantPanel(model: model))
        hosting.appearance = NSAppearance(named: .darkAqua)
        // The panel's own ideal height, so a quiet panel photographs as short
        // as it actually is.
        let height = max(hosting.fittingSize.height, 120)
        let frame = NSRect(x: 0, y: 0, width: CosmosTokens.panelWidth, height: height)
        let window = NSWindow(contentRect: frame, styleMask: [.borderless, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .darkAqua)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.contentView = hosting
        hosting.frame = frame
        hosting.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        guard let bitmap = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
            throw ClientFailure.invalidResponse
        }
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else {
            throw ClientFailure.invalidResponse
        }
        try png.write(to: url)
        print("[snapshot] \(url.path) \(bitmap.pixelsWide)x\(bitmap.pixelsHigh)")
        window.contentView = nil
    }

    // MARK: Fixtures

    /// One harmless entry that runs long enough to photograph.
    static func sleeperPolicy() throws -> (document: Data, held: HeldPolicy) {
        try fixturePolicy(commands: fixtureCommands([entry()]))
    }

    static func entry() -> CommandEntry {
        CommandEntry(id: "project-tests", label: "Project tests", argv: ["/bin/sleep", "120"],
                     cwd: "/usr/bin", mutates: true, budgetMs: 120_000)
    }

    static func request(expiresAtMs: Int64) throws -> ConfirmationRequest {
        try ConfirmationRequest(
            grantID: UUID(uuidString: "e5aa0000-0000-4000-8000-000000000001")!,
            actionID: UUID(uuidString: "6a1fa0f2-0000-4000-8000-000000000003")!,
            turnID: UUID(uuidString: "9c02a0f2-0000-4000-8000-000000000004")!,
            generation: 7,
            description: try ActionDescription(verb: "run", subject: "Project tests",
                                               deviceKind: "macos",
                                               effect: "changes files in that project",
                                               privacyClass: "private"),
            descriptionDigest: "5630269f110ea730effc829a754c9ecb27e240f2a7a95a6b433c866f05ab906c",
            risk: .high, attestation: .deviceOwnerAuth, privacy: "private",
            expiresAtMs: expiresAtMs)
    }

    static func reply() throws -> DisplayCard {
        try DisplayCard(
            actionID: UUID(uuidString: "7b2fa0f2-0000-4000-8000-000000000011")!,
            turnID: UUID(uuidString: "9c02a0f2-0000-4000-8000-000000000012")!,
            generation: 3, contentDigest: String(repeating: "d", count: 64),
            expiresAtMs: 1_757_260_000_000,
            content: .text("It's 17 degrees and overcast in Copenhagen, with light rain expected "
                           + "around six this evening."),
            privacy: "near_user")
    }

    static func shownHere() throws -> TurnStatus {
        try TurnStatus(turnID: UUID(uuidString: "9c02a0f2-0000-4000-8000-000000000012")!,
                       generation: 3, state: .shown, surfacePlatform: "macos", privacy: "near_user")
    }

    static func task() throws -> DeviceTask {
        let entry = entry()
        return try DeviceTask(
            actionID: UUID(uuidString: "6a1fa0f2-0000-4000-8000-000000000003")!,
            turnID: UUID(uuidString: "9c02a0f2-0000-4000-8000-000000000004")!,
            generation: 7, channel: "action.run",
            contentDigest: String(repeating: "b", count: 64),
            idempotencyKey: String(repeating: "a", count: 64),
            operation: .run(entryID: entry.id, label: entry.label, entryDigest: entry.entryDigest,
                            argvDigest: entry.argvDigest, budgetMs: entry.budgetMs,
                            mutates: entry.mutates),
            expiresAtMs: 1_757_260_000_000, reportByMs: 1_757_260_030_000, privacy: "private")
    }

    private func until(_ condition: () -> Bool, timeout: Duration = .seconds(20)) async throws {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while !condition() {
            guard ContinuousClock.now < deadline else { return XCTFail("condition never held") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }
}
