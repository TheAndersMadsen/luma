import AppKit
import SwiftUI
import XCTest
@testable import CosmosMac

/// Draws with real AppKit text/layout and a synthetic availability signal.
/// No window is ordered onto the owner's desktop by this test.
private final class DocumentTestWindow: NSWindow {
    var canObserve = false
    override var isVisible: Bool { true }
    override var occlusionState: NSWindow.OcclusionState { canObserve ? .visible : [] }
}

private func transferredDocumentWire() throws -> [String: Any] {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }
    let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf:
        root.appendingPathComponent("contracts/fixtures/ambiance-document-snapshot-v1.json"))) as? [String: Any])
    let frame = try XCTUnwrap(fixture["frame"] as? [String: Any])
    var command = try XCTUnwrap(frame["command"] as? [String: Any])
    command["expiresAtMs"] = command.removeValue(forKey: "expiresAt")
    command["reportByMs"] = command.removeValue(forKey: "reportBy")
    return command
}

final class DocumentSnapshotTests: XCTestCase {
    func testTransferredDocumentNeedsNoDestinationFileAndChecksItsBoundTask() throws {
        let wire = try transferredDocumentWire()
        func decode(_ wire: [String: Any]) throws -> DeviceTask {
            try JSONDecoder().decode(DeviceTask.self, from: JSONSerialization.data(withJSONObject: wire))
        }
        let task = try decode(wire)
        let policy = DevicePolicy(roots: [DeviceRoot(id: "notes", label: "Notes", path: "/no/destination/files")])
        guard case .success(.showDocument(let content)) = policy.plan(task.operation, document: task.document) else {
            return XCTFail("the transferred text needs no file on this Mac")
        }
        XCTAssertEqual(content.text, "This document has three lines.\n\nFirst line\nSecond 🚀 line\n<p>literal</p>")
        XCTAssertEqual(content.cursor, "This document has three lines.\n\nFirst line\n".utf16.count)
        XCTAssertEqual(content.line, 2)
        XCTAssertEqual(content.digest, task.document?.version)
        XCTAssertEqual(task.document?.digest, "dae6fa9bf73324372aad86fa073b7ca77447437dcb56d73e266a0ab9a19d5174")
        XCTAssertEqual(DevicePolicy().plan(task.operation, document: task.document), .failure(.notPermitted))
        XCTAssertEqual(policy.plan(task.operation), .failure(.versionChanged))
        for key in ["text", "explanation", "version", "taskId", "revision"] {
            var changed = wire
            var document = try XCTUnwrap(wire["document"] as? [String: Any])
            document[key] = key == "revision" ? 3 : "changed"
            changed["document"] = document
            XCTAssertThrowsError(try decode(changed), key)
        }
        var missing = wire
        missing.removeValue(forKey: "document")
        XCTAssertThrowsError(try decode(missing))
    }

    func testOriginalBytesAndUTF16LinePositionArePreserved() throws {
        let bytes = Data("😀 First line\r\nNext line\r\n".utf8)
        let value = try DocumentSnapshot(bytes: bytes, version: CanonicalJSON.hexDigest(bytes), position: .line(2))
        XCTAssertEqual(value.text, "😀 First line\nNext line\n")
        XCTAssertEqual(value.digest, CanonicalJSON.hexDigest(bytes))
        XCTAssertEqual(value.cursor, 14)
        XCTAssertEqual(value.debugDescription, "DocumentSnapshot([REDACTED])")
    }

    func testOnlyBoundedPlainTextAtAnExistingLineCanBeDisplayed() throws {
        let cases: [(Data, DevicePosition?, ActionRefusal)] = [
            (Data("a\n".utf8), .line(3), .unresolvable),
            (Data("a".utf8), .line(0), .unresolvable),
            (Data("a".utf8), .page(1), .noHandler),
            (Data("a".utf8), .fragment("a"), .noHandler),
            (Data([0xff]), nil, .noHandler), (Data([0x61, 0, 0x62]), nil, .noHandler),
            (Data(repeating: 65, count: DocumentSnapshot.maximumBytes + 1), nil, .noHandler),
        ]
        for (bytes, position, reason) in cases {
            XCTAssertThrowsError(try DocumentSnapshot(bytes: bytes, version: CanonicalJSON.hexDigest(bytes),
                                                       position: position)) { XCTAssertEqual($0 as? ActionRefusal, reason) }
        }
        let bytes = Data("<img src=\"https://example.test/image\"><script>nothing()</script>".utf8)
        let value = try DocumentSnapshot(bytes: bytes, version: CanonicalJSON.hexDigest(bytes), position: nil)
        XCTAssertEqual(value.text, String(data: bytes, encoding: .utf8))
        XCTAssertThrowsError(try DocumentSnapshot(bytes: bytes, version: String(repeating: "a", count: 64), position: nil)) {
            XCTAssertEqual($0 as? ActionRefusal, .versionChanged)
        }
        XCTAssertEqual(try DocumentSnapshot(bytes: Data(), version: CanonicalJSON.hexDigest(Data()), position: nil).cursor, 0)
    }

    func testPositionsAreNeverSilentlyDroppedByExternalOpeners() throws {
        let policy = DevicePolicy(hosts: ["example.test"], apps: [DeviceApp(id: "dev.zed.Zed", label: "Zed")])
        XCTAssertEqual(policy.plan(.open(locator: .https(url: "https://example.test/document#old"), version: nil,
                                         position: .fragment("new section"), label: "Document")),
                       .success(.openLink(URL(string: "https://example.test/document#new%20section")!)))
        for position in [DevicePosition.line(2), .page(2)] {
            XCTAssertEqual(policy.plan(.open(locator: .https(url: "https://example.test/document"), version: nil,
                                             position: position, label: "Document")), .failure(.noHandler))
        }
        XCTAssertEqual(policy.plan(.open(locator: .app(id: "dev.zed.Zed"), version: nil,
                                         position: .line(2), label: "Zed")), .failure(.noHandler))
    }
}

@MainActor
final class DocumentDestinationTests: XCTestCase {
    private func ready(transferred: Bool = false) async throws -> (ClientModel, MockClientBridge, DeviceTask, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("cosmos-viewer-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("notes.txt")
        let bytes = Data("First line\nKeep this version\n".utf8)
        if !transferred { try bytes.write(to: file) }
        let client = try MockClientBridge()
        client.deliver(try fixturePolicy(actions: fixtureActions(
            roots: [DeviceRoot(id: "notes", label: "Notes", path: root.path)])))
        let model = ClientModel(client: client, initialServerOrigin: "https://center.example.invalid")
        model.prepare()
        try await until { !model.busy && model.descriptor != nil }
        model.connect()
        try await until { !model.busy && model.policy != nil }
        model.setVisible(true)
        try await until { model.snapshot.visible }
        let operation = DeviceOperation.open(locator: .file(rootID: "notes", relative: "notes.txt"),
                                               version: CanonicalJSON.hexDigest(bytes), position: .line(2), label: "Notes")
        var task = try DeviceTask(actionID: UUID(), turnID: UUID(), generation: 1, channel: "action.open",
                                  contentDigest: String(repeating: "b", count: 64),
                                  idempotencyKey: String(repeating: "a", count: 64), operation: operation,
                                  expiresAtMs: ClientModel.nowMs() + 60_000,
                                  reportByMs: ClientModel.nowMs() + 10_000, privacy: "shared_room")
        if transferred {
            var wire = try transferredDocumentWire()
            let expires = ClientModel.nowMs() + 60_000
            wire["expiresAtMs"] = expires
            wire["reportByMs"] = ClientModel.nowMs() + 10_000
            var operation = try XCTUnwrap(wire["operation"] as? [String: Any])
            var locator = try XCTUnwrap(operation["locator"] as? [String: Any])
            var content = try XCTUnwrap(locator["content"] as? [String: Any])
            content["expiresAtMs"] = expires
            content["audience"] = fixtureSurface.uuidString.lowercased()
            locator["content"] = content
            operation["locator"] = locator
            wire["operation"] = operation
            task = try JSONDecoder().decode(DeviceTask.self, from: JSONSerialization.data(withJSONObject: wire))
        }
        client.publish(ClientSnapshot(phase: .connected, visible: true, task: task))
        try await until { model.presentedDocument != nil }
        return (model, client, task, file)
    }

    func testAnAcknowledgmentDoesNotCompleteAndLaterFileChangesCannotReplaceTheSnapshot() async throws {
        let (model, client, task, file) = try await ready()
        defer { model.closeDocument() }
        let snapshot = try XCTUnwrap(model.presentedDocument?.content)
        XCTAssertEqual(client.acknowledgedTasks, [task])
        XCTAssertTrue(client.reports.isEmpty, "binding is not rendering")
        try Data("A different document\n".utf8).write(to: file)
        XCTAssertEqual(model.presentedDocument?.content.text, "First line\nKeep this version\n")
        XCTAssertFalse(model.documentCommitted(actionID: task.actionID, digest: String(repeating: "f", count: 64), line: 2))
        XCTAssertFalse(model.documentCommitted(actionID: task.actionID, digest: snapshot.digest, line: 1))
        XCTAssertFalse(model.documentCommitted(actionID: UUID(), digest: snapshot.digest, line: 2))
        XCTAssertTrue(client.reports.isEmpty)
        XCTAssertTrue(model.documentCommitted(actionID: task.actionID, digest: snapshot.digest, line: 2))
        XCTAssertEqual(model.taskCard?.state, Words.working, "the report has not committed yet")
        XCTAssertFalse(model.documentCommitted(actionID: task.actionID, digest: snapshot.digest, line: 2))
        try await until { client.reports.count == 1 }
        XCTAssertEqual(client.reports.first?.0, ActionReport(outcome: .completed, evidence: .open(
            resolvedApp: "dk.andersmadsen.cosmos.desktop", opened: true, documentDigest: snapshot.digest)))
        XCTAssertEqual(client.reports.first?.1, task)
    }

    func testARejectedRenderReportCannotAnnounceCompletion() async throws {
        let (model, client, task, _) = try await ready()
        defer { model.closeDocument() }
        let snapshot = try XCTUnwrap(model.presentedDocument?.content)
        client.reportHandler = { _, _ in throw ClientFailure.connectionUnavailable }
        XCTAssertTrue(model.documentCommitted(actionID: task.actionID, digest: snapshot.digest, line: snapshot.line))
        XCTAssertEqual(model.taskCard?.state, Words.working)
        try await until { model.activity == .cannotConfirm }
        XCTAssertNotEqual(model.taskCard?.state, Words.completed)
    }

    func testRevokingACompletedTransferredViewDropsContentWithoutRewritingItsOutcome() async throws {
        let (model, client, task, file) = try await ready(transferred: true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        let content = try XCTUnwrap(model.presentedDocument?.content)
        XCTAssertTrue(model.documentCommitted(actionID: task.actionID, digest: content.digest, line: content.line))
        try await until { model.taskCard?.state == Words.completed }
        client.publish(ClientSnapshot(phase: .connected, visible: true, task: task,
                                      revoked: RevokedTask(actionID: task.actionID, reason: .expired)))
        XCTAssertNil(model.presentedDocument)
        XCTAssertEqual(model.taskCard?.state, Words.completed)
        XCTAssertEqual(client.reports.count, 1)
    }

    func testVisibilityPermissionAndCancellationReleaseBytesAndInvalidateLateFrames() async throws {
        for transition in ["hide", "cancel", "disconnect", "policy", "revoke"] {
            let (model, client, task, _) = try await ready()
            let digest = try XCTUnwrap(model.presentedDocument?.content.digest)
            switch transition {
            case "hide": model.setVisible(false)
            case "cancel": model.cancelTask()
            case "disconnect": client.publish(ClientSnapshot(phase: .disconnected))
            case "policy":
                client.deliver(try fixturePolicy(actions: fixtureActions(hosts: ["example.test"], revision: 3),
                                                 actionsRevision: 3))
                client.publish(ClientSnapshot(phase: .connected, visible: true, task: task))
            default:
                client.publish(ClientSnapshot(phase: .connected, visible: true, task: task,
                                               revoked: RevokedTask(actionID: task.actionID, reason: .cancelled)))
            }
            XCTAssertNil(model.presentedDocument, transition)
            XCTAssertFalse(model.documentCommitted(actionID: task.actionID, digest: digest, line: 2), transition)
            try await until { !client.reports.isEmpty }
            XCTAssertNotEqual(client.reports.first?.0.outcome, .completed, transition)
        }
    }

    func testOffscreenDocumentPaintWithSyntheticVisibility() async throws {
        let (model, client, task, file) = try await ready(transferred: true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        defer { model.closeDocument() }
        _ = NSApplication.shared
        let presentation = try XCTUnwrap(model.presentedDocument)
        let view = NSHostingView(rootView: DocumentView(presentation: presentation, committed: model.documentCommitted)
            .frame(width: 640, height: 300))
        let window = DocumentTestWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 300),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = "Cosmos document rendering test"
        window.contentView = view
        defer { window.close() }
        XCTAssertTrue(client.reports.isEmpty)
        view.layoutSubtreeIfNeeded()
        func textView(in view: NSView) -> SnapshotTextView? {
            if let text = view as? SnapshotTextView { return text }
            return view.subviews.compactMap { textView(in: $0) }.first
        }
        let text = try XCTUnwrap(textView(in: view))
        let frame = try XCTUnwrap(text.bitmapImageRepForCachingDisplay(in: text.bounds))
        XCTAssertEqual(text.string, presentation.content.text)
        XCTAssertTrue(text.string.hasPrefix("This document has three lines.\n\n"))
        XCTAssertEqual(text.selectedRange().location, presentation.content.cursor)
        text.cacheDisplay(in: text.bounds, to: frame)
        await Task.yield()
        XCTAssertTrue(client.reports.isEmpty, "an occluded frame cannot complete the document")
        window.canObserve = true
        XCTAssertTrue(text.showsRequestedLine())
        text.cacheDisplay(in: text.bounds, to: frame)
        try await until { client.reports.count == 1 }
        XCTAssertEqual(client.reports.first?.0.outcome, .completed)
        XCTAssertEqual(client.reports.first?.1, task)
        if let output = ProcessInfo.processInfo.environment["COSMOS_DOCUMENT_VIEW_IMAGE"],
           let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
            view.cacheDisplay(in: view.bounds, to: bitmap)
            try bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: output))
        }
        model.closeDocument()
        text.cacheDisplay(in: text.bounds, to: frame)
        XCTAssertFalse(model.documentCommitted(actionID: task.actionID, digest: presentation.content.digest,
                                                line: presentation.content.line))
        XCTAssertEqual(client.reports.count, 1)
    }

    private func until(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !condition() {
            if ContinuousClock.now >= deadline { throw ClientFailure.connectionUnavailable }
            try await Task.sleep(for: .milliseconds(10))
        }
    }
}
