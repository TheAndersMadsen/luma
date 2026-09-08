import Foundation
import XCTest
@testable import CosmosMac

final class SavedFileAttachmentTests: XCTestCase {
    func directory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory
    }

    func policy(_ root: URL) -> DevicePolicy {
        DevicePolicy(roots: [DeviceRoot(id: "docs", label: "Documents", path: root.path)])
    }

    func testReadsTheCompleteOriginalVersionWithoutNormalizingLineEndings() throws {
        let root = try directory()
        let file = root.appendingPathComponent("notes.txt")
        let bytes = Data("First line\r\nSecond 🚀 line\r\n".utf8)
        try bytes.write(to: file)
        let attachment = try SavedFileAttachment.read(url: file, policy: policy(root))
        XCTAssertEqual(Data(attachment.context.text.utf8), bytes)
        XCTAssertFalse(attachment.context.truncated)
        XCTAssertEqual(attachment.context.source, .file)
        XCTAssertEqual(attachment.document.version, CanonicalJSON.hexDigest(bytes))
        XCTAssertEqual(attachment.document.locator, .file(rootID: "docs", relative: "notes.txt"))
        XCTAssertFalse(String(decoding: attachment.document.encoded(), as: UTF8.self).contains(root.path))
    }

    func testRequiresTheSourceRootAndRejectsSymlinksOutsideIt() throws {
        let root = try directory(), outside = try directory()
        let file = outside.appendingPathComponent("outside.txt")
        try Data("Outside the permitted root".utf8).write(to: file)
        XCTAssertThrowsError(try SavedFileAttachment.read(url: file, policy: nil))
        XCTAssertThrowsError(try SavedFileAttachment.read(url: file, policy: policy(root)))
        let link = root.appendingPathComponent("link.txt")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
        XCTAssertThrowsError(try SavedFileAttachment.read(url: link, policy: policy(root)))
    }

    func testUnsupportedAndOversizedFilesNeverBecomePartialContext() throws {
        let root = try directory(), file = root.appendingPathComponent("notes.txt")
        for bytes in [Data(), Data(" \r\n".utf8), Data([255]), Data("a\0b".utf8), Data("a\rb".utf8),
                      Data(repeating: 120, count: 8001), Data(repeating: 34, count: 6000)] {
            try bytes.write(to: file)
            XCTAssertThrowsError(try SavedFileAttachment.read(url: file, policy: policy(root)))
        }
    }

    func testReadsOnlyRegularFilesAndNamesTheMostSpecificRoot() throws {
        let root = try directory(), nested = root.appendingPathComponent("nested")
        try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: false)
        XCTAssertThrowsError(try SavedFileAttachment.read(url: nested, policy: policy(root)))
        let file = nested.appendingPathComponent("notes.txt")
        try Data("A saved document".utf8).write(to: file)
        let policy = DevicePolicy(roots: [DeviceRoot(id: "docs", label: "Documents", path: root.path),
                                         DeviceRoot(id: "nested", label: "Nested", path: nested.path)])
        XCTAssertEqual(try SavedFileAttachment.read(url: file, policy: policy).document.locator,
                       .file(rootID: "nested", relative: "notes.txt"))
    }
}
