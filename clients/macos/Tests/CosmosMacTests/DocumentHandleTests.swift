import Foundation
import XCTest
@testable import CosmosMac

/// Naming the document the owner is looking at. Every decision here is a pure
/// function of what the application said and what the owner declared, so all of
/// it is exercised against real directories, real symlinks and real bytes.
final class DocumentHandleTests: XCTestCase {
    /// The temporary tree standing in for the owner's own directories, fully
    /// resolved, because /var is a symlink to /private/var on every Mac.
    private var directory = URL(fileURLWithPath: "/")

    override func setUpWithError() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("cosmos-document-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        directory = URL(fileURLWithPath: try XCTUnwrap(Filesystem.real.resolve(base.path)),
                        isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    @discardableResult
    private func write(_ relative: String, _ contents: String = "hello") throws -> String {
        let url = directory.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data(contents.utf8).write(to: url)
        return url.path
    }

    private func root(_ id: String = "repo", at relative: String = "repo",
                      label: String = "The repository") -> DeviceRoot {
        DeviceRoot(id: id, label: label, path: directory.appendingPathComponent(relative).path)
    }

    private func policy(_ roots: [DeviceRoot] = [], hosts: [String] = []) -> DevicePolicy {
        DevicePolicy(hosts: hosts, roots: roots)
    }

    // MARK: A path, and the root the owner declared

    func testAPathIsNamedByTheRootTheOwnerDeclaredAndOneOutsideIsNotNamedAtAll() throws {
        let path = try write("repo/src/state.rs")
        let declared = [root()]

        let located = try XCTUnwrap(DocumentNaming.locate(path, roots: declared))
        XCTAssertEqual(located.rootID, "repo")
        XCTAssertEqual(located.relative, "src/state.rs")
        XCTAssertEqual(located.path, path)

        // Everything outside every declared root is simply not named. There is
        // no absolute path anywhere in this shape to fall back to.
        let outside = try write("elsewhere/notes.md")
        XCTAssertNil(DocumentNaming.locate(outside, roots: declared))
        XCTAssertNil(DocumentNaming.locate(path, roots: []), "no roots, no names")
        XCTAssertNil(DocumentNaming.locate(directory.appendingPathComponent("repo").path, roots: declared),
                     "the root's own directory is not a document in it")
        XCTAssertNil(DocumentNaming.locate(directory.appendingPathComponent("repo/gone.rs").path,
                                           roots: declared), "a path that does not resolve names nothing")

        // A root the owner could never have written is not a root at all.
        XCTAssertNil(DocumentNaming.locate(path, roots: [DeviceRoot(id: "Repo!", label: "x",
                                                                   path: root().path)]))
        XCTAssertNil(DocumentNaming.locate(path, roots: [DeviceRoot(id: String(repeating: "r", count: 33),
                                                                   label: "x", path: root().path)]))
    }

    func testASymlinkOutOfTheRootIsOutOfTheRoot() throws {
        let secret = try write("elsewhere/secret.txt")
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("repo"),
                                                withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            at: directory.appendingPathComponent("repo/link.txt"), withDestinationURL: URL(fileURLWithPath: secret))
        // Both sides resolve first, so the link's own path is the one outside.
        XCTAssertNil(DocumentNaming.locate(directory.appendingPathComponent("repo/link.txt").path,
                                           roots: [root()]))
    }

    func testTheMostSpecificDeclaredRootWins() throws {
        let path = try write("home/repo/src/state.rs")
        let roots = [DeviceRoot(id: "home", label: "Home", path: directory.appendingPathComponent("home").path),
                     root("repo", at: "home/repo")]
        for order in [roots, roots.reversed()] {
            let located = try XCTUnwrap(DocumentNaming.locate(path, roots: Array(order)))
            XCTAssertEqual(located.rootID, "repo")
            XCTAssertEqual(located.relative, "src/state.rs")
        }
    }

    func testARelativePathPastTheWireBoundIsNotNamed() throws {
        let deep = (1...3).map { String(repeating: "d\($0)", count: 100) }.joined(separator: "/")
        let path = try write("repo/\(deep)/state.rs")
        XCTAssertGreaterThan(deep.utf8.count, DocumentLocator.maximumRelativeBytes)
        XCTAssertNil(DocumentNaming.locate(path, roots: [root()]))
        // The same file one directory shallower is inside the bound and named.
        let shallow = try write("repo/src/state.rs")
        XCTAssertNotNil(DocumentNaming.locate(shallow, roots: [root()]))
    }

    // MARK: The version is the file's own bytes

    func testTheVersionIsTheSHA256OfTheFilesOwnBytes() throws {
        let path = try write("repo/notes.md", "abc")
        let handle = try XCTUnwrap(DocumentNaming.handle(
            for: DocumentObservation(subject: .file(path: path), label: "notes.md"),
            app: "Zed", policy: policy([root()])))
        // The digest the destination will recompute from the file it finds.
        XCTAssertEqual(handle.version,
                       "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertEqual(handle.version, Filesystem.real.digest(path))
        XCTAssertTrue(handle.valid)

        // A document with no bytes this Mac can hash is not named: the
        // destination would have nothing to check the file it opens against.
        let folder = directory.appendingPathComponent("repo/src", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        XCTAssertNil(DocumentNaming.handle(
            for: DocumentObservation(subject: .file(path: folder.path), label: "src"),
            app: "Zed", policy: policy([root()])))
    }

    // MARK: Where in it the owner is

    func testEachPositionKindTravelsInItsOwnShape() {
        XCTAssertEqual(DocumentPosition.line(1710).wire as? [String: AnyHashable],
                       ["kind": "line", "line": 1710])
        XCTAssertEqual(DocumentPosition.page(4).wire as? [String: AnyHashable],
                       ["kind": "page", "page": 4])
        XCTAssertEqual(DocumentPosition.fragment("results").wire as? [String: AnyHashable],
                       ["kind": "fragment", "value": "results"])
        XCTAssertEqual(DocumentPosition.line(42).caption, "line 42")
        XCTAssertEqual(DocumentPosition.page(4).caption, "page 4")
        XCTAssertEqual(DocumentPosition.fragment("results").caption, "#results")

        // The runtime's own bounds, so nothing this Mac sends is refused there.
        for valid in [DocumentPosition.line(1), .line(1_000_000), .page(1), .page(100_000),
                      .fragment("a"), .fragment(String(repeating: "f", count: 200))] {
            XCTAssertTrue(valid.valid, "\(valid)")
        }
        for invalid in [DocumentPosition.line(0), .line(-1), .line(1_000_001), .page(0), .page(100_001),
                        .fragment(""), .fragment("  "), .fragment("a\nb"),
                        .fragment(String(repeating: "f", count: 201))] {
            XCTAssertFalse(invalid.valid, "\(invalid)")
        }
    }

    func testAPlaceTheLocatorCannotCarryIsDroppedRatherThanSent() throws {
        let path = try write("repo/state.rs")
        func named(_ position: DocumentPosition?) throws -> DocumentHandle {
            try XCTUnwrap(DocumentNaming.handle(
                for: DocumentObservation(subject: .file(path: path), position: position, label: "state.rs"),
                app: "Zed", policy: policy([root()])))
        }
        XCTAssertEqual(try named(.line(1710)).position, .line(1710))
        XCTAssertEqual(try named(.page(3)).position, .page(3))
        // A fragment means nothing in a file, and a line means nothing in a
        // browser: the document is still named, without a place.
        XCTAssertNil(try named(.fragment("results")).position)
        XCTAssertNil(try named(.line(0)).position, "a place outside the bound is no place at all")
        XCTAssertNil(try named(nil).position)

        let web = try XCTUnwrap(DocumentNaming.handle(
            for: DocumentObservation(subject: .web(url: "https://docs.test/guide"), position: .line(12),
                                     label: "The guide"),
            app: "Safari", policy: policy(hosts: ["docs.test"])))
        XCTAssertNil(web.position)
    }

    // MARK: A page the owner is reading

    func testAPageIsNamedOnAHostTheOwnerAllowedAndNowhereElse() throws {
        let handle = try XCTUnwrap(DocumentNaming.handle(
            for: DocumentObservation(subject: .web(url: "https://docs.test/guide#results"),
                                     label: "The guide"),
            app: "Safari", policy: policy(hosts: ["docs.test"])))
        // The fragment is the place; the locator is the document itself.
        XCTAssertEqual(handle.locator, .https(url: "https://docs.test/guide"))
        XCTAssertEqual(handle.position, .fragment("results"))
        XCTAssertNil(handle.version, "this Mac holds no ETag and never hashes what a browser drew")
        XCTAssertEqual(handle.label, "The guide")

        for refused in ["https://elsewhere.test/guide", "http://docs.test/guide",
                        "https://user@docs.test/guide", "https://docs.test:8443/guide",
                        "https://docs.test/a b", "https://docs.test/a\\b"] {
            XCTAssertNil(DocumentNaming.handle(
                for: DocumentObservation(subject: .web(url: refused), label: "The guide"),
                app: "Safari", policy: policy(hosts: ["docs.test"])), refused)
        }
        // The page's own title is what a person calls it; without one, its host.
        let untitled = try XCTUnwrap(DocumentNaming.handle(
            for: DocumentObservation(subject: .web(url: "https://docs.test/guide"), label: " "),
            app: "Safari", policy: policy(hosts: ["docs.test"])))
        XCTAssertEqual(untitled.label, "docs.test")
    }

    // MARK: The bounds the wire applies

    func testTheByteBoundsAreTheRuntimesOwn() throws {
        let path = try write("repo/state.rs")
        func named(app: String, label: String) -> DocumentHandle? {
            DocumentNaming.handle(for: DocumentObservation(subject: .file(path: path), label: label),
                                  app: app, policy: policy([root()]))
        }
        // An over-long name is shortened on a character boundary, never dropped.
        let long = try XCTUnwrap(named(app: String(repeating: "é", count: 40),
                                       label: String(repeating: "ø", count: 80)))
        XCTAssertEqual(long.app.utf8.count, DocumentHandle.maximumAppBytes)
        XCTAssertEqual(long.label.utf8.count, DocumentHandle.maximumLabelBytes)
        XCTAssertTrue(long.valid)
        // A name that is only whitespace or control characters falls back to the
        // file's own name.
        XCTAssertEqual(try XCTUnwrap(named(app: "Zed", label: " \n ")).label, "state.rs")
        XCTAssertEqual(try XCTUnwrap(named(app: "  ", label: "state.rs")).app, ContextChip.unknownApp)

        // And the shapes the runtime refuses are refused here first.
        let good = DocumentHandle(app: "Zed", locator: .file(rootID: "repo", relative: "src/state.rs"),
                                  version: String(repeating: "7", count: 64), position: .line(1),
                                  label: "state.rs")
        XCTAssertTrue(good.valid)
        let refused: [DocumentLocator] = [
            .file(rootID: "repo", relative: "../secrets"),
            .file(rootID: "repo", relative: "/etc/passwd"),
            .file(rootID: "repo", relative: "a//b"),
            .file(rootID: "repo", relative: "a/./b"),
            .file(rootID: "repo", relative: "a\\b"),
            .file(rootID: "repo", relative: ""),
            .file(rootID: "REPO", relative: "a"),
            .file(rootID: "", relative: "a"),
            .file(rootID: "repo", relative: String(repeating: "a", count: 513)),
            .https(url: "https://docs.test/" + String(repeating: "a", count: 2048)),
        ]
        for locator in refused {
            XCTAssertFalse(DocumentHandle(app: "Zed", locator: locator, label: "x").valid, "\(locator)")
        }
        for version in ["", "short", String(repeating: "7", count: 63), String(repeating: "7", count: 65),
                        String(repeating: "F", count: 64), String(repeating: "g", count: 64)] {
            XCTAssertFalse(DocumentHandle(app: "Zed", locator: good.locator, version: version,
                                          label: "x").valid, version)
        }
        XCTAssertFalse(DocumentHandle(app: String(repeating: "a", count: 65), locator: good.locator,
                                      label: "x").valid)
        XCTAssertFalse(DocumentHandle(app: "Zed", locator: good.locator,
                                      label: String(repeating: "a", count: 121)).valid)
        XCTAssertFalse(DocumentHandle(app: "Zed", locator: good.locator, label: " ").valid)
        XCTAssertFalse(DocumentHandle(app: "Zed", locator: good.locator, position: .line(0),
                                      label: "x").valid)
    }

    // MARK: The wire shape itself

    func testTheEncodedHandleIsExactlyTheFiveFieldsTheRuntimeAccepts() throws {
        let handle = DocumentHandle(app: "Zed", locator: .file(rootID: "repo", relative: "src/state.rs"),
                                    version: String(repeating: "7", count: 64), position: .line(1710),
                                    label: "state.rs")
        let encoded = String(decoding: handle.encoded(), as: UTF8.self)
        XCTAssertEqual(encoded, """
        {"app":"Zed","label":"state.rs","locator":{"relative":"src\\/state.rs","rootId":"repo",\
        "scheme":"file"},"position":{"kind":"line","line":1710},"version":"\(String(repeating: "7", count: 64))"}
        """)
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: handle.encoded()) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["app", "locator", "version", "position", "label"])
        XCTAssertFalse(encoded.contains("text"), "the handle carries no bytes and no screen text")

        // The two optional fields are absent rather than null when there is
        // nothing to say, because the runtime rejects a field it does not know
        // and reads an absent one as none.
        let page = DocumentHandle(app: "Safari", locator: .https(url: "https://docs.test/guide"),
                                  label: "The guide")
        let bare = try XCTUnwrap(try JSONSerialization.jsonObject(with: page.encoded()) as? [String: Any])
        XCTAssertEqual(Set(bare.keys), ["app", "locator", "label"])
        XCTAssertEqual(bare["locator"] as? [String: String], ["scheme": "https",
                                                              "url": "https://docs.test/guide"])
    }

    /// What the owner's log may carry: enough to see that a handoff was offered,
    /// and nothing of what they were reading.
    func testTheLoggedSummaryNamesNoPathNoNameAndNoFragment() {
        let file = DocumentHandle(app: "Zed", locator: .file(rootID: "repo", relative: "src/secret-plans.rs"),
                                  version: String(repeating: "7", count: 64), position: .line(1710),
                                  label: "secret-plans.rs")
        XCTAssertEqual(file.summary, "file root=repo version=77777777… position=line 1710")
        let page = DocumentHandle(app: "Safari", locator: .https(url: "https://docs.test/guide"),
                                  position: .fragment("my-medical-results"), label: "The guide")
        XCTAssertEqual(page.summary, "https host=docs.test position=fragment")
        for summary in [file.summary, page.summary] {
            XCTAssertFalse(summary.contains("secret"), summary)
            XCTAssertFalse(summary.contains("medical"), summary)
        }
    }

    // MARK: When nothing can be named

    func testNothingIsNamedWhenNothingCanBeNamedHonestly() throws {
        let path = try write("repo/state.rs")
        let seen = DocumentObservation(subject: .file(path: path), position: .line(4), label: "state.rs")
        // Holding no policy at all is the ordinary state, and it names nothing.
        XCTAssertNil(DocumentNaming.handle(for: seen, app: "Zed", policy: nil))
        // A policy that declares no root of its own names nothing either.
        XCTAssertNil(DocumentNaming.handle(for: seen, app: "Zed", policy: policy(hosts: ["docs.test"])))
        // And an application that says nothing about what it is showing.
        XCTAssertNil(DocumentNaming.handle(for: nil, app: "Zed", policy: policy([root()])))
        // A root the owner declared elsewhere does not cover this file.
        XCTAssertNil(DocumentNaming.handle(for: seen, app: "Zed",
                                           policy: policy([root("notes", at: "elsewhere")])))
        XCTAssertNotNil(DocumentNaming.handle(for: seen, app: "Zed", policy: policy([root()])))
    }
}
