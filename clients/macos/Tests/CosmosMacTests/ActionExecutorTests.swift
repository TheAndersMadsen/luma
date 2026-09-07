import Foundation
import LocalAuthentication
import XCTest
@testable import CosmosMac

/// Everything this Mac checks before it does anything, and everything it says
/// afterwards. Each test is the pure function on its own, against real
/// directories, real symlinks and one real child process.
final class ActionExecutorTests: XCTestCase {
    // MARK: Fixtures

    static let entry = CommandEntry(
        id: "project-tests", label: "Project tests",
        argv: ["./revival", "check", "cosmos"], cwd: "/Users/owner/Projects/ai-pin-revival",
        mutates: true, budgetMs: 900_000
    )

    static func policy(roots: [DeviceRoot] = [], hosts: [String] = ["github.com"],
                       apps: [DeviceApp] = [], entries: [CommandEntry] = [entry]) -> DevicePolicy {
        DevicePolicy(hosts: hosts, apps: apps, roots: roots, entries: entries)
    }

    static func task(_ operation: DeviceOperation, key: String = String(repeating: "a", count: 64),
                     action: String = "6a1fa0f2-0000-4000-8000-000000000003") throws -> DeviceTask {
        try DeviceTask(
            actionID: UUID(uuidString: action)!,
            turnID: UUID(uuidString: "9c02a0f2-0000-4000-8000-000000000004")!,
            generation: 7,
            channel: {
                switch operation {
                case .run: "action.run"
                case .open: "action.open"
                case .unsupported(let kind): "action.\(kind)"
                }
            }(),
            contentDigest: String(repeating: "b", count: 64), idempotencyKey: key,
            operation: operation, expiresAtMs: 1_757_260_000_000, reportByMs: 1_757_260_030_000,
            privacy: "shared_room"
        )
    }

    static func runOperation(_ entry: CommandEntry) -> DeviceOperation {
        .run(entryID: entry.id, label: entry.label, entryDigest: entry.entryDigest,
             argvDigest: entry.argvDigest, budgetMs: entry.budgetMs, mutates: entry.mutates)
    }

    /// A directory tree this test owns, cleaned up when it ends.
    func temporaryDirectory() throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("cosmos-action-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        // The temporary directory itself is a symlink on macOS; resolve it so the
        // expectations below compare like with like.
        return URL(fileURLWithPath: Filesystem.real.resolve(url.path) ?? url.path, isDirectory: true)
    }

    // MARK: The canonical digests the whole fleet shares

    func testEveryDigestMatchesTheSharedFixture() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let url = root.appendingPathComponent("contracts/fixtures/ambiance-device-action-digests-v1.json")
        let file = try JSONSerialization.jsonObject(with: try Data(contentsOf: url)) as? [String: Any]
        let cases = try XCTUnwrap(file?["cases"] as? [[String: Any]])
        var byName: [String: (encoded: String, digest: String)] = [:]
        for entry in cases {
            let name = try XCTUnwrap(entry["name"] as? String)
            byName[name] = (try XCTUnwrap(entry["encoded"] as? String),
                            try XCTUnwrap(entry["digest"] as? String))
        }

        // The two vectors this Mac computes itself, so a drift in either
        // implementation refuses the command instead of running the wrong one.
        let argv = CanonicalJSON.Value.array([
            .string("cosmos.device-command.argv"), .integer(1),
            .array(Self.entry.argv.map(CanonicalJSON.Value.string)), .string(Self.entry.cwd),
        ])
        XCTAssertEqual(CanonicalJSON.encode(argv), byName["command-argv"]?.encoded)
        XCTAssertEqual(Self.entry.argvDigest, byName["command-argv"]?.digest)
        XCTAssertEqual(Self.entry.entryDigest, byName["command-entry"]?.digest)

        // Non-ASCII is written through raw and the solidus is never escaped, or
        // every route and every https locator would hash differently here.
        let route = CanonicalJSON.Value.array([
            .string("cosmos.device-action.route"), .integer(1), .string("ChIJa1b2c3d4e5f6"),
            .string("Restaurant Barr"), .string("Strandgade 93, 1401 København"),
            .string("55.673611"), .string("12.596944"),
        ])
        XCTAssertEqual(CanonicalJSON.encode(route), byName["route"]?.encoded)
        XCTAssertEqual(CanonicalJSON.digest(route), byName["route"]?.digest)
        let open = CanonicalJSON.Value.array([
            .string("cosmos.device-action.open"), .integer(1), .string("https"),
            .string("https://github.com/owner/repo/pull/412"), .null, .null,
            .string("fragment"), .string("discussion_r1"), .string("PR 412"),
        ])
        XCTAssertEqual(CanonicalJSON.encode(open), byName["open-https"]?.encoded)
        XCTAssertEqual(CanonicalJSON.digest(open), byName["open-https"]?.digest)
    }

    func testCanonicalJSONEscapesOnlyWhatItMust() {
        XCTAssertEqual(CanonicalJSON.encode(.string("a/b")), "\"a/b\"", "the solidus is never escaped")
        XCTAssertEqual(CanonicalJSON.encode(.string("\"\\")), "\"\\\"\\\\\"")
        XCTAssertEqual(CanonicalJSON.encode(.string("a\nb\tc")), "\"a\\nb\\tc\"")
        XCTAssertEqual(CanonicalJSON.encode(.string("\u{1f}")), "\"\\u001f\"")
        XCTAssertEqual(CanonicalJSON.encode(.string("København")), "\"København\"")
        XCTAssertEqual(CanonicalJSON.encode(.array([.integer(-1), .boolean(true), .null])), "[-1,true,null]")
    }

    // MARK: Re-verifying the command against the owner's own list

    func testRefusesAnActWhoseArgvDigestDoesNotMatchLocalPolicy() throws {
        let policy = Self.policy()
        // The owner edited the entry after Cosmos bound the command.
        let edited = CommandEntry(id: "project-tests", label: "Project tests",
                                  argv: ["./revival", "check", "center"], cwd: Self.entry.cwd,
                                  mutates: true, budgetMs: 900_000)
        XCTAssertNotEqual(edited.argvDigest, Self.entry.argvDigest)
        let stale = DeviceOperation.run(entryID: "project-tests", label: "Project tests",
                                        entryDigest: edited.entryDigest, argvDigest: edited.argvDigest,
                                        budgetMs: 900_000, mutates: true)
        XCTAssertEqual(policy.plan(stale), .failure(.entryChanged))
        // And the exact bound entry still passes.
        XCTAssertEqual(policy.plan(Self.runOperation(Self.entry)), .success(.run(Self.entry)))
    }

    func testRefusesAnEntryHostRootOrOperationAbsentFromTheLocalPolicyCopy() throws {
        let policy = Self.policy()
        XCTAssertEqual(policy.plan(Self.runOperation(
            CommandEntry(id: "lint", label: "Lint", argv: ["/usr/bin/true"], cwd: "/tmp",
                         mutates: false, budgetMs: 1000))), .failure(.notPermitted),
            "an entry id this Mac does not have is refused, whatever the digests say")
        XCTAssertEqual(policy.plan(.open(locator: .https(url: "https://evil.example/x"),
                                         version: nil, position: nil, label: "Page")),
                       .failure(.notPermitted), "a host absent from the local copy is refused")
        XCTAssertEqual(policy.plan(.open(locator: .https(url: "https://github.com/owner/repo"),
                                         version: nil, position: nil, label: "Repo")),
                       .success(.openLink(URL(string: "https://github.com/owner/repo")!)))
        XCTAssertEqual(policy.plan(.open(locator: .file(rootID: "repo", relative: "a.txt"),
                                         version: nil, position: nil, label: "a.txt")),
                       .failure(.unresolvable), "a root this installation does not have")
        XCTAssertEqual(policy.plan(.open(locator: .app(id: "dev.zed.Zed"),
                                         version: nil, position: nil, label: "Zed")),
                       .failure(.notPermitted), "an application the owner never listed")
        // An empty policy is a perfectly ordinary state, and it permits nothing.
        XCTAssertEqual(DevicePolicy().plan(Self.runOperation(Self.entry)), .failure(.notPermitted))
    }

    func testReportsUnsupportedForRouteAndPlay() throws {
        // This Mac declares neither channel. Both still decode, so both reach a
        // refusal with a reason rather than silence.
        for kind in ["route", "play"] {
            XCTAssertEqual(Self.policy().plan(.unsupported(kind: kind)), .failure(.noHandler))
        }
        let report = ActionReport.refusal(.noHandler)
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: report.encoded()) as? [String: Any])
        XCTAssertEqual(encoded["outcome"] as? String, "refused")
        XCTAssertEqual((encoded["evidence"] as? [String: Any])?["kind"] as? String, "declined")
        XCTAssertEqual((encoded["evidence"] as? [String: Any])?["reason"] as? String, "no_handler")
    }

    func testARejectedLocatorNeverBecomesAnOpen() throws {
        let policy = Self.policy(hosts: ["github.com"])
        for url in ["http://github.com/x", "https://user@github.com/x", "https://github.com:8443/x",
                    "https://GITHUB.COM.evil.example/x", "https://github.com./x"] {
            let plan = policy.plan(.open(locator: .https(url: url), version: nil, position: nil, label: "x"))
            XCTAssertNotEqual(plan, .success(.openLink(URL(string: url)!)), url)
        }
    }

    // MARK: Containment

    func testPathOutsideADeclaredRootIsRefused() throws {
        let base = try temporaryDirectory()
        let inside = base.appendingPathComponent("projects", isDirectory: true)
        try FileManager.default.createDirectory(at: inside, withIntermediateDirectories: true)
        try Data("hello\n".utf8).write(to: inside.appendingPathComponent("notes.txt"))
        try Data("secret\n".utf8).write(to: base.appendingPathComponent("outside.txt"))
        let root = DeviceRoot(id: "repo", label: "Projects", path: inside.path)
        let policy = Self.policy(roots: [root])

        XCTAssertEqual(policy.plan(.open(locator: .file(rootID: "repo", relative: "notes.txt"),
                                         version: nil, position: nil, label: "notes.txt")),
                       .success(.openFile(URL(fileURLWithPath: inside.appendingPathComponent("notes.txt").path))))
        // Traversal never reaches the filesystem: the relative path is refused
        // on its shape, and the resolved path is refused on its prefix.
        for relative in ["../outside.txt", "a/../../outside.txt", "/etc/hosts", "./notes.txt", ""] {
            XCTAssertEqual(policy.plan(.open(locator: .file(rootID: "repo", relative: relative),
                                             version: nil, position: nil, label: "x")),
                           .failure(.notPermitted), relative)
        }
    }

    func testSymlinkEscapeIsRefused() throws {
        let base = try temporaryDirectory()
        let inside = base.appendingPathComponent("projects", isDirectory: true)
        try FileManager.default.createDirectory(at: inside, withIntermediateDirectories: true)
        let secret = base.appendingPathComponent("outside.txt")
        try Data("secret\n".utf8).write(to: secret)
        // A name inside the root that points out of it. realpath follows it, so
        // the resolved path is outside and the command is refused.
        try FileManager.default.createSymbolicLink(at: inside.appendingPathComponent("escape.txt"),
                                                   withDestinationURL: secret)
        try FileManager.default.createSymbolicLink(at: inside.appendingPathComponent("up"),
                                                   withDestinationURL: base)
        let policy = Self.policy(roots: [DeviceRoot(id: "repo", label: "Projects", path: inside.path)])
        XCTAssertEqual(policy.plan(.open(locator: .file(rootID: "repo", relative: "escape.txt"),
                                         version: nil, position: nil, label: "x")),
                       .failure(.notPermitted), "a symlink out of the root is still out of the root")
        XCTAssertEqual(policy.plan(.open(locator: .file(rootID: "repo", relative: "up/outside.txt"),
                                         version: nil, position: nil, label: "x")),
                       .failure(.notPermitted))
        XCTAssertEqual(policy.plan(.open(locator: .file(rootID: "repo", relative: "missing.txt"),
                                         version: nil, position: nil, label: "x")),
                       .failure(.unresolvable))
    }

    func testADocumentThatChangedIsRefusedRatherThanOpened() throws {
        let base = try temporaryDirectory()
        let file = base.appendingPathComponent("state.rs")
        try Data("fn main() {}\n".utf8).write(to: file)
        let digest = try XCTUnwrap(Filesystem.real.digest(file.path))
        let policy = Self.policy(roots: [DeviceRoot(id: "repo", label: "Projects", path: base.path)])
        XCTAssertEqual(policy.plan(.open(locator: .file(rootID: "repo", relative: "state.rs"),
                                         version: digest, position: .line(17), label: "state.rs")),
                       .success(.openFile(URL(fileURLWithPath: file.path))))
        try Data("fn main() { changed() }\n".utf8).write(to: file)
        XCTAssertEqual(policy.plan(.open(locator: .file(rootID: "repo", relative: "state.rs"),
                                         version: digest, position: .line(17), label: "state.rs")),
                       .failure(.versionChanged))
    }

    // MARK: The attestation rule

    func testHighRiskWithoutDeviceOwnerAuthIsRefusedBeforeSpawn() throws {
        // Cosmos declares actor_unknown everywhere, so a tap can never mint the
        // evidence a command that changes files needs.
        XCTAssertEqual(ActorAttestation.required(mutates: true), .deviceOwnerAuth)
        XCTAssertEqual(ActorAttestation.required(mutates: false), .foregroundTap)
        XCTAssertFalse(ActorAttestation.permitsRun(mutates: true, held: .foregroundTap))
        XCTAssertFalse(ActorAttestation.permitsRun(mutates: true, held: nil))
        XCTAssertTrue(ActorAttestation.permitsRun(mutates: true, held: .deviceOwnerAuth))
        XCTAssertFalse(ActorAttestation.permitsRun(mutates: false, held: nil))
        XCTAssertTrue(ActorAttestation.permitsRun(mutates: false, held: .foregroundTap))
        XCTAssertTrue(ActorAttestation.permitsRun(mutates: false, held: .deviceOwnerAuth),
                      "stronger evidence than asked for is still an answer")
        XCTAssertTrue(ActorAttestation.satisfies(.deviceOwnerAuth, required: .deviceOwnerAuth))
        XCTAssertFalse(ActorAttestation.satisfies(.foregroundTap, required: .deviceOwnerAuth))
    }

    func testAnUnsignedBuildSaysSoInsteadOfCrashing() {
        // Each way the system can refuse to ask reads as one plain sentence, and
        // nothing technical reaches it.
        let unsigned = NSError(domain: LAErrorDomain, code: -1004)  // invalidContext
        XCTAssertEqual(DeviceOwnerAuthenticator.sentence(for: unsigned), Words.attestationUnsignedBuild)
        let notSetUp = NSError(domain: LAErrorDomain, code: -5)  // passcodeNotSet
        XCTAssertEqual(DeviceOwnerAuthenticator.sentence(for: notSetUp), Words.attestationNotSetUp)
        XCTAssertEqual(DeviceOwnerAuthenticator.sentence(for: nil), Words.attestationUnavailable)
        XCTAssertEqual(DeviceOwnerAuthenticator.sentence(for: NSError(domain: "other", code: 1)),
                       Words.attestationUnavailable)
        for sentence in [Words.attestationUnsignedBuild, Words.attestationNotSetUp, Words.attestationUnavailable] {
            XCTAssertFalse(sentence.contains("LAError"), "no framework name reaches a person")
            XCTAssertTrue(sentence.hasSuffix("."), sentence)
        }
    }

    // MARK: Argv fixity and the environment

    func testArgvIsTheOwnersFixedArrayAndTheEnvironmentIsScrubbed() throws {
        // Nothing composes a command line: the plan hands back the owner's own
        // entry, and the only substitution is argv[0]'s resolved path.
        let policy = Self.policy()
        guard case .success(.run(let planned)) = policy.plan(Self.runOperation(Self.entry)) else {
            return XCTFail("the bound entry must plan to the owner's own entry")
        }
        XCTAssertEqual(planned.argv, ["./revival", "check", "cosmos"])
        XCTAssertFalse(planned.argv.contains { $0.contains("sh") || $0.contains("-c") })

        let environment = CommandProcess.scrubbedEnvironment(
            ["PATH": "/usr/bin", "LANG": "da_DK.UTF-8", "AWS_SECRET_ACCESS_KEY": "leak",
             "SSH_AUTH_SOCK": "/private/tmp/agent"], home: "/Users/owner")
        XCTAssertEqual(Set(environment.keys), ["PATH", "HOME", "LANG", "TERM", "NO_COLOR"])
        XCTAssertEqual(environment["TERM"], "dumb")
        XCTAssertEqual(environment["NO_COLOR"], "1")
        XCTAssertEqual(environment["HOME"], "/Users/owner")
        XCTAssertEqual(environment["PATH"], "/usr/bin")
        XCTAssertNil(environment["AWS_SECRET_ACCESS_KEY"])
        XCTAssertNil(environment["SSH_AUTH_SOCK"])
    }

    func testAnExecutableOutsideItsWorkingDirectoryHasNoHandler() throws {
        let base = try temporaryDirectory()
        let script = base.appendingPathComponent("run.sh")
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let good = CommandEntry(id: "run", label: "Run", argv: ["run.sh"], cwd: base.path,
                                mutates: false, budgetMs: 5000)
        XCTAssertEqual(CommandProcess.executable(for: good), .success(script.path))
        let missing = CommandEntry(id: "run", label: "Run", argv: ["absent.sh"], cwd: base.path,
                                   mutates: false, budgetMs: 5000)
        XCTAssertEqual(CommandProcess.executable(for: missing), .failure(.noHandler))
        let escaping = CommandEntry(id: "run", label: "Run", argv: ["../elsewhere.sh"], cwd: base.path,
                                    mutates: false, budgetMs: 5000)
        XCTAssertEqual(CommandProcess.executable(for: escaping), .failure(.notPermitted))
        let elsewhere = CommandEntry(id: "run", label: "Run", argv: ["/no/such/binary"], cwd: base.path,
                                     mutates: false, budgetMs: 5000)
        XCTAssertEqual(CommandProcess.executable(for: elsewhere), .failure(.noHandler))
        let notExecutable = CommandEntry(id: "run", label: "Run", argv: ["/etc/hosts"], cwd: base.path,
                                         mutates: false, budgetMs: 5000)
        XCTAssertEqual(CommandProcess.executable(for: notExecutable), .failure(.noHandler))
    }

    // MARK: One real child process

    func testSpawnsWithoutAShellInItsOwnProcessGroupAndReportsExitCodeOneAsCompleted() async throws {
        let base = try temporaryDirectory()
        let script = base.appendingPathComponent("failing.sh")
        try Data("#!/bin/sh\necho \"two failed\"\necho oops >&2\nexit 1\n".utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let entry = CommandEntry(id: "tests", label: "Project tests", argv: [script.path],
                                 cwd: base.path, mutates: false, budgetMs: 20_000)
        let process = try CommandProcess(entry: entry, executable: script.path, workingDirectory: base.path)
        // A new process group led by the child, so a revoke reaches everything
        // the command started rather than only the command.
        XCTAssertEqual(getpgid(process.pid), process.pid)
        let result = await process.wait(budgetMs: entry.budgetMs)
        XCTAssertEqual(result.exitCode, 1)
        XCTAssertFalse(result.stopped)
        XCTAssertTrue(result.output.contains("two failed"), result.output)
        XCTAssertTrue(result.output.contains("oops"), "stderr is the command's output too")

        // Exit one is a command that ran, which is what was asked.
        let report = ActionExecutor.report(entry: entry, result: result)
        XCTAssertEqual(report.outcome, .completed)
        XCTAssertEqual(report.evidence, .command(entryID: "tests", exitCode: 1,
                                                 durationMs: result.durationMs,
                                                 outputBytes: result.outputBytes, truncated: false))
        XCTAssertEqual(TaskCard.finished(label: "Project tests", exitCode: 1, durationMs: 48_211),
                       .completed(sentence: "Project tests finished after 48 seconds.",
                                  detail: "It ended with exit code 1."))
    }

    func testKillsTheProcessGroupOnRevoke() async throws {
        let base = try temporaryDirectory()
        let script = base.appendingPathComponent("group.sh")
        // The command starts a child of its own; stopping the group has to reach
        // it, which is the whole reason the child leads one.
        try Data("#!/bin/sh\n/bin/sleep 60 &\necho $!\nwait\n".utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let entry = CommandEntry(id: "sleeper", label: "Sleeper", argv: [script.path],
                                 cwd: base.path, mutates: false, budgetMs: 60_000)
        let process = try CommandProcess(entry: entry, executable: script.path, workingDirectory: base.path)
        let leader = process.pid
        XCTAssertEqual(getpgid(leader), leader)

        let finished = Task { await process.wait(budgetMs: entry.budgetMs) }
        try await Task.sleep(for: .milliseconds(400))
        process.stop()
        let result = await finished.value
        XCTAssertTrue(result.stopped)
        XCTAssertNil(result.exitCode, "a signalled command exited with no code of its own")

        // The grandchild the command started is gone with it.
        let grandchild = pid_t(result.output.trimmingCharacters(in: .whitespacesAndNewlines)) ?? -1
        XCTAssertGreaterThan(grandchild, 0, "the fixture printed its child's pid: \(result.output)")
        var alive = true
        for _ in 0..<40 where alive {
            try await Task.sleep(for: .milliseconds(100))
            alive = kill(grandchild, 0) == 0
        }
        XCTAssertFalse(alive, "stopping the task stops the whole process group")

        // Stopping is something this Mac can prove, so it says cancelled.
        XCTAssertEqual(ActionExecutor.report(entry: entry, result: result).outcome, .cancelled)
    }

    func testABudgetItOutlivesStopsTheCommandAndSaysSo() async throws {
        let base = try temporaryDirectory()
        let script = base.appendingPathComponent("slow.sh")
        try Data("#!/bin/sh\n/bin/sleep 30\n".utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let entry = CommandEntry(id: "slow", label: "Slow", argv: [script.path], cwd: base.path,
                                 mutates: false, budgetMs: 300)
        let process = try CommandProcess(entry: entry, executable: script.path, workingDirectory: base.path)
        let result = await process.wait(budgetMs: entry.budgetMs)
        XCTAssertTrue(result.stopped)
        XCTAssertEqual(ActionExecutor.report(entry: entry, result: result).outcome, .cancelled)
    }

    // MARK: Output

    func testOutputIsHeadAndTailTrimmedAtSixKiB() {
        XCTAssertEqual(ActionExecutor.maximumOutputBytes, 6144)
        let head = String(repeating: "H", count: 5000)
        let middle = String(repeating: "M", count: 40_000)
        let tail = String(repeating: "T", count: 5000)
        let (trimmed, truncated) = ActionExecutor.trim(Data((head + middle + tail).utf8))
        XCTAssertTrue(truncated)
        XCTAssertLessThanOrEqual(trimmed.utf8.count, 6144)
        XCTAssertTrue(trimmed.hasPrefix("HHH"), "the beginning is kept")
        XCTAssertTrue(trimmed.hasSuffix("TTT"), "and so is the end")
        XCTAssertTrue(trimmed.contains("[…]"), "the elision is visible, not silent")
        XCTAssertFalse(trimmed.contains("MMMM"), "the middle is the part that goes")

        let short = "two tests failed\n"
        XCTAssertEqual(ActionExecutor.trim(Data(short.utf8)).0, short)
        XCTAssertFalse(ActionExecutor.trim(Data(short.utf8)).1)

        // A report may carry newlines and tabs and nothing else below 0x20.
        let noisy = "a\u{1B}[31mred\u{1B}[0m\u{0}b\u{7}\rc\td\n"
        let sanitized = ActionExecutor.sanitize(noisy)
        XCTAssertEqual(sanitized, "aredb\nc\td\n")
        XCTAssertFalse(sanitized.unicodeScalars.contains { $0.value < 0x20 && $0 != "\n" && $0 != "\t" })

        // Multi-byte text is never cut through a scalar.
        let wide = String(repeating: "æ", count: 8000)
        let (cut, _) = ActionExecutor.trim(Data(wide.utf8))
        XCTAssertLessThanOrEqual(cut.utf8.count, 6144)
        XCTAssertFalse(cut.unicodeScalars.contains("\u{FFFD}"), "no replacement character from a bad cut")
    }

    // MARK: Deduplication

    @MainActor
    func testDedupesOnIdempotencyKeyWithoutRunningAnythingTwice() {
        let executor = ActionExecutor()
        let key = String(repeating: "c", count: 64)
        let now: Int64 = 1_757_260_000_000
        XCTAssertNil(executor.report(forKey: key, now: now))
        let first = ActionReport(outcome: .completed,
                                 evidence: .command(entryID: "project-tests", exitCode: 0,
                                                    durationMs: 1200, outputBytes: 12, truncated: false))
        executor.remember(first, forKey: key, now: now)
        XCTAssertEqual(executor.report(forKey: key, now: now + 1000), first,
                       "a repeat re-sends the report the first one produced")
        // Remembering again never replaces the first answer.
        executor.remember(ActionReport.refusal(.notPermitted), forKey: key, now: now + 2000)
        XCTAssertEqual(executor.report(forKey: key, now: now + 2000), first)
        // Ten minutes, as Cosmos retains it.
        XCTAssertEqual(ActionExecutor.dedupeWindowMs, 600_000)
        XCTAssertNil(executor.report(forKey: key, now: now + 600_001))
        XCTAssertNil(executor.report(forKey: String(repeating: "d", count: 64), now: now))
    }

    // MARK: Opening

    @MainActor
    func testOpeningReportsOnlyWhatTheWorkspaceDid() throws {
        let executor = ActionExecutor()
        let url = URL(string: "https://github.com/owner/repo/pull/412")!
        let took = WorkspaceOpener(open: { _ in "com.apple.Safari" }, launch: { _ in nil })
        XCTAssertEqual(executor.open(.openLink(url), opener: took),
                       ActionReport(outcome: .completed,
                                    evidence: .open(resolvedApp: "com.apple.Safari", opened: true,
                                                    documentDigest: nil)))
        let refused = WorkspaceOpener(open: { _ in nil }, launch: { _ in nil })
        let report = executor.open(.openLink(url), opener: refused)
        XCTAssertEqual(report.outcome, .failed)
        XCTAssertEqual(report.evidence, .open(resolvedApp: nil, opened: false, documentDigest: nil))
        // A launch this Mac cannot observe further is not completed.
        let launched = WorkspaceOpener(open: { _ in nil }, launch: { $0 })
        XCTAssertEqual(executor.open(.openApplication(bundleID: "dev.zed.Zed"), opener: launched).outcome,
                       .unknown)
        XCTAssertEqual(executor.open(.openApplication(bundleID: "dev.zed.Zed"), opener: refused),
                       ActionReport.refusal(.noHandler))
    }

    func testTheReportShapeIsTheOneTheLibraryParses() throws {
        let report = ActionReport(
            outcome: .completed,
            evidence: .command(entryID: "project-tests", exitCode: 1, durationMs: 48_211,
                               outputBytes: 18_422, truncated: true),
            output: "two failed\n"
        )
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: report.encoded()) as? [String: Any])
        XCTAssertEqual(object["outcome"] as? String, "completed")
        XCTAssertEqual(object["output"] as? String, "two failed\n")
        let evidence = try XCTUnwrap(object["evidence"] as? [String: Any])
        XCTAssertEqual(evidence["kind"] as? String, "command")
        XCTAssertEqual(evidence["entryId"] as? String, "project-tests")
        XCTAssertEqual(evidence["exitCode"] as? Int, 1)
        XCTAssertEqual(evidence["durationMs"] as? Int, 48_211)
        XCTAssertEqual(evidence["outputBytes"] as? Int, 18_422)
        XCTAssertEqual(evidence["truncated"] as? Bool, true)
        // An absent exit code is absent, not zero.
        let stopped = ActionReport(outcome: .cancelled,
                                   evidence: .command(entryID: "x", exitCode: nil, durationMs: 1,
                                                      outputBytes: 0, truncated: false))
        let stoppedEvidence = try XCTUnwrap(
            (JSONSerialization.jsonObject(with: stopped.encoded()) as? [String: Any])?["evidence"] as? [String: Any])
        XCTAssertNil(stoppedEvidence["exitCode"])
    }

    // MARK: The delivered policy

    /// The copy is read against what the snapshot said it is, and against every
    /// bound the runtime itself applies when the owner saves it. Anything out
    /// of shape anywhere leaves this Mac holding nothing at all.
    func testTheDeliveredPolicyIsHeldWholeOrNotAtAll() throws {
        let app = DeviceApp(id: "dev.zed.Zed", label: "Zed")
        let root = DeviceRoot(id: "repo", label: "Projects", path: "/Users/owner/Projects")
        let delivered = try fixturePolicy(
            actions: fixtureActions(hosts: ["github.com"], apps: [app], roots: [root]),
            commands: fixtureCommands([Self.entry])
        )
        let policy = try XCTUnwrap(DevicePolicy.decode(delivered.document, held: delivered.held))
        XCTAssertEqual(policy.hosts, ["github.com"])
        XCTAssertEqual(policy.apps, [app])
        XCTAssertEqual(policy.root("repo")?.path, "/Users/owner/Projects")
        XCTAssertEqual(policy.entry("project-tests")?.argv, ["./revival", "check", "cosmos"])
        XCTAssertEqual(policy.entry("project-tests")?.entryDigest, Self.entry.entryDigest)
        XCTAssertFalse(policy.isEmpty)

        // The owner allowed device actions and no commands at all, or the other
        // way round: both are ordinary, and each is held for what it says.
        let openOnly = try fixturePolicy(actions: fixtureActions(hosts: ["github.com"]))
        XCTAssertEqual(DevicePolicy.decode(openOnly.document, held: openOnly.held)?.entries, [])
        let runOnly = try fixturePolicy(commands: fixtureCommands([Self.entry]))
        XCTAssertEqual(DevicePolicy.decode(runOnly.document, held: runOnly.held)?.hosts, [])

        // Not the document the snapshot named: a different length, a digest
        // that does not match, or bytes that are not it at all.
        var shortened = delivered.held
        shortened = try HeldPolicy(surfaceID: shortened.surfaceID,
                                   approvalRevision: shortened.approvalRevision,
                                   actionsRevision: shortened.actionsRevision,
                                   commandsRevision: shortened.commandsRevision,
                                   digest: shortened.digest,
                                   byteLength: shortened.byteLength - 1)
        XCTAssertNil(DevicePolicy.decode(delivered.document, held: shortened))
        let wrongDigest = try HeldPolicy(surfaceID: delivered.held.surfaceID,
                                        approvalRevision: delivered.held.approvalRevision,
                                        actionsRevision: delivered.held.actionsRevision,
                                        commandsRevision: delivered.held.commandsRevision,
                                        digest: String(repeating: "c", count: 64),
                                        byteLength: delivered.held.byteLength)
        XCTAssertNil(DevicePolicy.decode(delivered.document, held: wrongDigest))

        // Somebody else's permission: another surface, or another approval.
        let elsewhere = try fixturePolicy(surface: UUID(uuidString: "5f1e0000-0000-4000-8000-0000000000b2")!,
                                          commands: fixtureCommands([Self.entry]))
        XCTAssertNil(DevicePolicy.decode(elsewhere.document, held: runOnly.held))
        let laterApproval = try fixturePolicy(approval: 9, commands: fixtureCommands([Self.entry]))
        XCTAssertNil(DevicePolicy.decode(laterApproval.document, held: runOnly.held))

        // A section is present at exactly the revision the snapshot named.
        let drifted = try fixturePolicy(commands: fixtureCommands([Self.entry], revision: 4),
                                        commandsRevision: 3)
        XCTAssertNil(DevicePolicy.decode(drifted.document, held: drifted.held))

        // Half an allowlist is worse than none: an unknown field, a section
        // this Mac's manifest does not declare, a missing class, an empty open
        // list, or an entry out of the runtime's own bounds.
        for actions in [
            fixtureActions(hosts: ["github.com"]).replacingOccurrences(of: "\"open\"", with: "\"route\""),
            fixtureActions(hosts: ["github.com"]).replacingOccurrences(of: "\"maximumClass\"", with: "\"class\""),
            fixtureActions(hosts: ["github.com"]).replacingOccurrences(of: "shared_room", with: "everyone"),
            fixtureActions(hosts: ["github.com", "github.com"]),
            fixtureActions(hosts: ["fine.example", "a.example"]),
            fixtureActions(hosts: ["Not-A-Host"]),
            fixtureActions(),
        ] {
            let bad = try fixturePolicy(actions: actions)
            XCTAssertNil(DevicePolicy.decode(bad.document, held: bad.held), actions)
        }
        for commands in [
            fixtureCommands([]),
            fixtureCommands([CommandEntry(id: "x", label: "X", argv: [], cwd: "/tmp",
                                          mutates: false, budgetMs: 1000)]),
            fixtureCommands([CommandEntry(id: "x", label: "X", argv: ["../../bin/sh"], cwd: "/tmp",
                                          mutates: false, budgetMs: 1000)]),
            fixtureCommands([CommandEntry(id: "x", label: "X", argv: ["/bin/true"], cwd: "relative",
                                          mutates: false, budgetMs: 1000)]),
            fixtureCommands([CommandEntry(id: "x", label: "X", argv: ["/bin/true"], cwd: "/tmp",
                                          mutates: false, budgetMs: 900_001)]),
            fixtureCommands([Self.entry]).replacingOccurrences(of: "\"offerOutputToCognition\":false,",
                                                              with: ""),
            fixtureCommands([Self.entry]).replacingOccurrences(of: "\"budgetMs\"", with: "\"budget\""),
        ] {
            let bad = try fixturePolicy(commands: commands)
            XCTAssertNil(DevicePolicy.decode(bad.document, held: bad.held), commands)
        }

        // And a document that is not a version 1 object at all.
        for text in ["not json", "[]", "{\"version\":2}", "{}"] {
            let bytes = Data(text.utf8)
            let held = try HeldPolicy(surfaceID: fixtureSurface, approvalRevision: 4,
                                      actionsRevision: nil, commandsRevision: 3,
                                      digest: CanonicalJSON.hexDigest(bytes),
                                      byteLength: bytes.count)
            XCTAssertNil(DevicePolicy.decode(bytes, held: held), text)
        }

        // The snapshot record itself is bounded: a nil surface, a zero
        // revision, a short digest or a document over the cap is no record.
        XCTAssertThrowsError(try HeldPolicy(surfaceID: fixtureSurface, approvalRevision: 0,
                                            actionsRevision: 1, commandsRevision: nil,
                                            digest: String(repeating: "a", count: 64), byteLength: 10))
        XCTAssertThrowsError(try HeldPolicy(surfaceID: fixtureSurface, approvalRevision: 1,
                                            actionsRevision: nil, commandsRevision: nil,
                                            digest: String(repeating: "a", count: 64), byteLength: 10))
        XCTAssertThrowsError(try HeldPolicy(surfaceID: fixtureSurface, approvalRevision: 1,
                                            actionsRevision: 1, commandsRevision: nil,
                                            digest: "short", byteLength: 10))
        XCTAssertThrowsError(try HeldPolicy(surfaceID: fixtureSurface, approvalRevision: 1,
                                            actionsRevision: 1, commandsRevision: nil,
                                            digest: String(repeating: "a", count: 64),
                                            byteLength: DevicePolicy.maximumBytes + 1))
    }

    /// The snapshot names the copy in the shape the library sends.
    func testTheSnapshotPolicyRecordDecodesFromTheSnapshotShape() throws {
        let record = """
        {"surfaceId":"5f1e0000-0000-4000-8000-0000000000a1","approvalRevision":4,
         "actionsRevision":null,"commandsRevision":3,
         "digest":"\(String(repeating: "a", count: 64))","byteLength":128}
        """
        let held = try JSONDecoder().decode(HeldPolicy.self, from: Data(record.utf8))
        XCTAssertEqual(held.surfaceID, fixtureSurface)
        XCTAssertEqual(held.approvalRevision, 4)
        XCTAssertNil(held.actionsRevision, "a section it was given nothing for is null, not zero")
        XCTAssertEqual(held.commandsRevision, 3)
        for bad in [record.replacingOccurrences(of: "\"commandsRevision\":3", with: "\"commandsRevision\":null"),
                    record.replacingOccurrences(of: "\"byteLength\":128", with: "\"byteLength\":0"),
                    record.replacingOccurrences(of: String(repeating: "a", count: 64), with: "A")] {
            XCTAssertThrowsError(try JSONDecoder().decode(HeldPolicy.self, from: Data(bad.utf8)), bad)
        }
    }
}
