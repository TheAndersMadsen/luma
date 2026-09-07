import AppKit
import Darwin
import Foundation

/// Carrying out one command on this Mac, and saying only what was observed.
///
/// Two things happen here and nothing else: an `https` locator the owner
/// allowed or a file under a root they declared is handed to the workspace, and
/// one entry from the owner's own list is spawned with its fixed argv. There is
/// no shell, no interpolation and no value taken from a model or a page. The
/// child gets its own process group so a revoke stops everything it started,
/// and its output is the owner's bytes: captured, bounded, and reported as
/// content rather than as this Mac's claim about anything.

// MARK: What the workspace was asked to do

/// The two workspace calls, injected so every check around them is tested
/// without opening an application on the owner's Mac.
public struct WorkspaceOpener: Sendable {
    /// Opens the locator and answers with the bundle id that took it, or nil
    /// when nothing did.
    public var open: @MainActor @Sendable (URL) -> String?
    /// Launches an application by bundle id.
    public var launch: @MainActor @Sendable (String) -> String?

    public init(open: @escaping @MainActor @Sendable (URL) -> String?,
                launch: @escaping @MainActor @Sendable (String) -> String?) {
        self.open = open
        self.launch = launch
    }

    public static let system = WorkspaceOpener(
        open: { url in
            let workspace = NSWorkspace.shared
            // Ask which application will take it before opening, so the report
            // names what actually handled the locator.
            let handler = workspace.urlForApplication(toOpen: url)
                .flatMap { Bundle(url: $0)?.bundleIdentifier }
            return workspace.open(url) ? (handler ?? "") : nil
        },
        launch: { identifier in
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: identifier) else { return nil }
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            NSWorkspace.shared.openApplication(at: url, configuration: configuration)
            return identifier
        }
    )
}

// MARK: One spawned command

public struct CommandResult: Equatable, Sendable {
    /// Nil when the command was signalled rather than exiting on its own.
    public let exitCode: Int32?
    public let stopped: Bool
    public let durationMs: Int64
    public let output: String
    public let outputBytes: UInt32
    public let truncated: Bool

    public init(exitCode: Int32?, stopped: Bool, durationMs: Int64,
                output: String, outputBytes: UInt32, truncated: Bool) {
        self.exitCode = exitCode
        self.stopped = stopped
        self.durationMs = durationMs
        self.output = output
        self.outputBytes = outputBytes
        self.truncated = truncated
    }
}

/// Keeps the head and the tail of a stream and forgets the middle, so a command
/// that prints for ten minutes still costs bounded memory and still shows both
/// ends of what it said.
final class OutputCapture: @unchecked Sendable {
    private let lock = NSLock()
    private let side: Int
    private var buffer = Data()
    private var counted = 0
    private var lost = false

    init(side: Int = 64 * 1024) {
        self.side = side
    }

    func append(_ chunk: Data) {
        guard !chunk.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        counted += chunk.count
        buffer.append(chunk)
        if buffer.count > side * 2 {
            buffer = Data(buffer.prefix(side)) + Data(buffer.suffix(side))
            lost = true
        }
    }

    /// Every byte the command printed, whether or not it was kept.
    var total: Int {
        lock.lock()
        defer { lock.unlock() }
        return counted
    }

    /// True once the middle of the stream was dropped to stay bounded.
    var dropped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return lost
    }

    var bytes: Data {
        lock.lock()
        defer { lock.unlock() }
        return buffer
    }
}

/// One child process in its own process group, with a scrubbed environment and
/// no shell anywhere in the path from the owner's entry to `execve`.
public final class CommandProcess: @unchecked Sendable {
    public let pid: pid_t
    private let capture = OutputCapture()
    private let started = DispatchTime.now()
    private let finished = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var status: Int32?
    private var reapedSignal: Int32?
    private var wasStopped = false

    /// Everything a command may see of this account. Nothing else is inherited:
    /// not the session, not tokens, not the caller's own variables.
    public static func scrubbedEnvironment(_ source: [String: String] = ProcessInfo.processInfo.environment,
                                           home: String = NSHomeDirectory()) -> [String: String] {
        [
            "PATH": source["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": home,
            "LANG": source["LANG"] ?? "en_US.UTF-8",
            "TERM": "dumb",
            "NO_COLOR": "1",
        ]
    }

    /// `argv[0]` is either absolute or resolves inside the entry's own working
    /// directory. Anything else, or anything that is not an executable regular
    /// file, has no handler here and is refused before a process exists.
    public static func executable(for entry: CommandEntry,
                                  filesystem: Filesystem = .real) -> Result<String, ActionRefusal> {
        guard let workingDirectory = filesystem.resolve(entry.cwd) else { return .failure(.unresolvable) }
        let candidate: String
        if entry.argv[0].hasPrefix("/") {
            candidate = entry.argv[0]
        } else {
            let root = DeviceRoot(id: "cwd", label: entry.cwd, path: workingDirectory)
            switch DevicePolicy.contain(entry.argv[0], under: root, filesystem: filesystem) {
            case .success(let resolved): candidate = resolved
            // A name that is simply not there is nothing this Mac can carry
            // out; one that leaves the directory is something it may not.
            case .failure(let reason): return .failure(reason == .unresolvable ? .noHandler : reason)
            }
        }
        guard let resolved = filesystem.resolve(candidate) else { return .failure(.noHandler) }
        var info = stat()
        guard stat(resolved, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              access(resolved, X_OK) == 0 else {
            return .failure(.noHandler)
        }
        return .success(resolved)
    }

    /// Spawns the entry. The child leads a new process group, reads nothing from
    /// this Mac's input, and inherits no descriptor of this application's.
    public init(entry: CommandEntry, executable: String, workingDirectory: String,
                environment: [String: String] = CommandProcess.scrubbedEnvironment()) throws {
        var outputPipe: [Int32] = [-1, -1]
        var errorPipe: [Int32] = [-1, -1]
        guard pipe(&outputPipe) == 0 else { throw ClientFailure.connectionUnavailable }
        guard pipe(&errorPipe) == 0 else {
            close(outputPipe[0]); close(outputPipe[1])
            throw ClientFailure.connectionUnavailable
        }
        let devnull = open("/dev/null", O_RDONLY)
        guard devnull >= 0 else {
            for descriptor in outputPipe + errorPipe { close(descriptor) }
            throw ClientFailure.connectionUnavailable
        }

        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        // A new process group, so a revoke can stop everything the command
        // started rather than only the command itself. CLOEXEC_DEFAULT closes
        // every descriptor this application holds, the journal lock included.
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
        posix_spawnattr_setpgroup(&attributes, 0)
        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        posix_spawn_file_actions_adddup2(&actions, devnull, 0)
        posix_spawn_file_actions_adddup2(&actions, outputPipe[1], 1)
        posix_spawn_file_actions_adddup2(&actions, errorPipe[1], 2)
        posix_spawn_file_actions_addchdir_np(&actions, workingDirectory)
        defer {
            posix_spawnattr_destroy(&attributes)
            posix_spawn_file_actions_destroy(&actions)
            close(devnull)
            close(outputPipe[1])
            close(errorPipe[1])
        }

        // The argv is the owner's own array, with argv[0] replaced by the exact
        // resolved path. No element is composed and none is a shell string.
        var arguments = entry.argv
        arguments[0] = executable
        let argv: [UnsafeMutablePointer<CChar>?] = arguments.map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] =
            environment.sorted { $0.key < $1.key }.map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            for pointer in argv where pointer != nil { free(pointer) }
            for pointer in envp where pointer != nil { free(pointer) }
        }
        var child: pid_t = -1
        let spawned = posix_spawn(&child, executable, &actions, &attributes, argv, envp)
        guard spawned == 0, child > 0 else {
            close(outputPipe[0])
            close(errorPipe[0])
            throw ClientFailure.connectionUnavailable
        }
        pid = child

        for descriptor in [outputPipe[0], errorPipe[0]] {
            let capture = capture
            DispatchQueue.global(qos: .utility).async {
                var chunk = [UInt8](repeating: 0, count: 1 << 15)
                while true {
                    let count = chunk.withUnsafeMutableBytes { read(descriptor, $0.baseAddress, $0.count) }
                    if count > 0 {
                        capture.append(Data(chunk.prefix(count)))
                    } else if count == 0 || errno != EINTR {
                        break
                    }
                }
                close(descriptor)
            }
        }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var state: Int32 = 0
            while waitpid(child, &state, 0) < 0 && errno == EINTR {}
            guard let self else { return }
            lock.lock()
            status = state
            lock.unlock()
            finished.signal()
        }
    }

    /// The child's exit status, and whether anything asked it to stop.
    private func settled(expired: Bool) -> (Int32?, Bool) {
        lock.lock()
        defer { lock.unlock() }
        return (status, wasStopped || expired)
    }

    /// Stops the whole process group: a request to end, then two seconds, then
    /// the end. Both signals go to `-pid`, which is the group this child leads.
    public func stop() {
        lock.lock()
        wasStopped = true
        let done = status != nil
        lock.unlock()
        guard !done else { return }
        kill(-pid, SIGTERM)
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .seconds(2)) { [weak self] in
            guard let self else { return }
            lock.lock()
            let settled = status != nil
            lock.unlock()
            if !settled { kill(-self.pid, SIGKILL) }
        }
    }

    /// Waits for the command and for its output to drain, up to its own budget.
    /// Exceeding the budget stops the group and returns what was seen.
    public func wait(budgetMs: Int64) async -> CommandResult {
        let semaphore = finished
        let expired: Bool = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                let deadline = DispatchTime.now() + .milliseconds(Int(max(budgetMs, 1)))
                continuation.resume(returning: semaphore.wait(timeout: deadline) == .timedOut)
            }
        }
        if expired {
            stop()
            await withCheckedContinuation { continuation in
                DispatchQueue.global(qos: .utility).async {
                    _ = semaphore.wait(timeout: .now() + .seconds(5))
                    continuation.resume()
                }
            }
        }
        // Give the readers a moment to drain the pipes the child just closed.
        try? await Task.sleep(for: .milliseconds(40))
        let (state, stopped) = settled(expired: expired)
        let elapsed = Int64((DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000)
        let total = capture.total
        let (text, truncated) = ActionExecutor.trim(capture.bytes)
        var exitCode: Int32?
        if let state, state & 0x7f == 0 { exitCode = (state >> 8) & 0xff }
        return CommandResult(
            exitCode: exitCode, stopped: stopped || exitCode == nil,
            durationMs: min(max(elapsed, 0), 900_000), output: text,
            outputBytes: UInt32(min(total, 16 * 1024 * 1024)),
            truncated: truncated || capture.dropped
        )
    }
}

// MARK: The executor

@MainActor
public final class ActionExecutor {
    /// A repeat of the same command produces no second effect, only the report
    /// the first one produced. Ten minutes, as Cosmos retains it.
    public nonisolated static let dedupeWindowMs: Int64 = 600_000
    /// The most a report may carry of the command's own output.
    public nonisolated static let maximumOutputBytes = 6144

    private var remembered: [(key: String, report: ActionReport, atMs: Int64)] = []
    private var current: CommandProcess?

    public init() {}

    public var isRunning: Bool { current != nil }

    // MARK: Deduplication

    public func report(forKey key: String, now: Int64) -> ActionReport? {
        prune(now: now)
        return remembered.first { $0.key == key }?.report
    }

    public func remember(_ report: ActionReport, forKey key: String, now: Int64) {
        prune(now: now)
        guard !remembered.contains(where: { $0.key == key }) else { return }
        remembered.append((key, report, now))
        if remembered.count > 32 { remembered.removeFirst(remembered.count - 32) }
    }

    private func prune(now: Int64) {
        remembered.removeAll { now - $0.atMs > Self.dedupeWindowMs || now < $0.atMs }
    }

    // MARK: Opening

    /// Hands the locator to the workspace and reports what it saw: which
    /// application took it, and whether it opened at all.
    public func open(_ planned: PlannedAction, opener: WorkspaceOpener = .system,
                     filesystem: Filesystem = .real) -> ActionReport {
        switch planned {
        case .openLink(let url):
            guard let handler = opener.open(url) else {
                return ActionReport(outcome: .failed, evidence: .open(resolvedApp: nil, opened: false,
                                                                     documentDigest: nil))
            }
            return ActionReport(outcome: .completed,
                                evidence: .open(resolvedApp: handler.isEmpty ? nil : handler,
                                                opened: true, documentDigest: nil))
        case .openFile(let url):
            let digest = filesystem.digest(url.path)
            guard let handler = opener.open(url) else {
                return ActionReport(outcome: .failed,
                                    evidence: .open(resolvedApp: nil, opened: false, documentDigest: digest))
            }
            return ActionReport(outcome: .completed,
                                evidence: .open(resolvedApp: handler.isEmpty ? nil : handler,
                                                opened: true, documentDigest: digest))
        case .openApplication(let identifier):
            guard let handler = opener.launch(identifier) else {
                return ActionReport.refusal(.noHandler)
            }
            // A launch this Mac cannot observe further is not an outcome.
            return ActionReport(outcome: .unknown,
                                evidence: .open(resolvedApp: handler, opened: false, documentDigest: nil))
        case .run:
            return ActionReport.refusal(.noHandler)
        }
    }

    // MARK: Running

    /// Starts the entry, or refuses before any process exists. The caller has
    /// already checked the policy and the attestation.
    public func start(_ entry: CommandEntry, filesystem: Filesystem = .real) -> Result<Void, ActionRefusal> {
        guard current == nil else { return .failure(.notPermitted) }
        guard let workingDirectory = filesystem.resolve(entry.cwd) else { return .failure(.unresolvable) }
        switch CommandProcess.executable(for: entry, filesystem: filesystem) {
        case .failure(let refusal): return .failure(refusal)
        case .success(let executable):
            guard let process = try? CommandProcess(entry: entry, executable: executable,
                                                    workingDirectory: workingDirectory) else {
                return .failure(.noHandler)
            }
            current = process
            return .success(())
        }
    }

    /// Waits for the running command and turns what happened into one report.
    public func finish(_ entry: CommandEntry) async -> ActionReport {
        guard let process = current else { return ActionReport.refusal(.noHandler) }
        let result = await process.wait(budgetMs: entry.budgetMs)
        current = nil
        return Self.report(entry: entry, result: result)
    }

    /// Stops the running command's whole process group.
    public func stop() {
        current?.stop()
    }

    /// A command that ran is `completed` whatever it exited with: "run the tests
    /// and tell me what failed" succeeds when the tests run, and exit 1 is the
    /// evidence. A command this Mac stopped is `cancelled`, because stopping it
    /// is something this Mac can prove.
    nonisolated public static func report(entry: CommandEntry, result: CommandResult) -> ActionReport {
        let evidence = ActionReport.Evidence.command(
            entryID: entry.id, exitCode: result.exitCode, durationMs: result.durationMs,
            outputBytes: result.outputBytes, truncated: result.truncated
        )
        let output = result.output.isEmpty ? nil : result.output
        if result.exitCode == nil || result.stopped {
            return ActionReport(outcome: .cancelled, evidence: evidence, output: output)
        }
        return ActionReport(outcome: .completed, evidence: evidence, output: output)
    }

    // MARK: Output

    /// The command's own bytes, made safe to carry and bounded to 6 KiB with
    /// both ends kept: a test run says what it started with and what it ended
    /// with, and the elision is visible rather than silent.
    nonisolated public static func trim(_ bytes: Data, limit: Int = ActionExecutor.maximumOutputBytes) -> (String, Bool) {
        let text = sanitize(String(decoding: bytes, as: UTF8.self))
        var utf8 = Array(text.utf8)
        guard utf8.count > limit else { return (text, false) }
        let marker = "\n[…]\n"
        let markerBytes = Array(marker.utf8)
        let budget = max(limit - markerBytes.count, 0)
        let head = boundary(utf8, upTo: budget - budget / 3)
        let tailStart = utf8.count - boundaryFromEnd(utf8, upTo: budget - head)
        utf8 = Array(utf8[0..<head]) + markerBytes + Array(utf8[tailStart...])
        return (String(decoding: utf8, as: UTF8.self), true)
    }

    /// Strips terminal control sequences and every control character a report
    /// may not carry, keeping newlines and tabs so the shape of the output
    /// survives. `TERM=dumb` and `NO_COLOR=1` mean there is usually nothing here.
    nonisolated public static func sanitize(_ text: String) -> String {
        var output = String.UnicodeScalarView()
        var scalars = Array(text.unicodeScalars)
        var index = 0
        while index < scalars.count {
            let scalar = scalars[index]
            if scalar == "\u{1B}" {
                index += 1
                if index < scalars.count, scalars[index] == "[" {
                    index += 1
                    while index < scalars.count, !(0x40...0x7E).contains(Int(scalars[index].value)) { index += 1 }
                }
                if index < scalars.count { index += 1 }
                continue
            }
            if scalar == "\r" {
                output.append("\n")
            } else if scalar == "\n" || scalar == "\t" || scalar.value >= 0x20 {
                if scalar.value != 0x7F { output.append(scalar) }
            }
            index += 1
        }
        // A carriage-return-heavy progress bar becomes a wall of blank lines.
        return String(String.UnicodeScalarView(output))
            .replacingOccurrences(of: "\n\n\n", with: "\n\n")
    }

    /// The largest prefix length that ends on a UTF-8 boundary.
    nonisolated private static func boundary(_ bytes: [UInt8], upTo count: Int) -> Int {
        var index = min(max(count, 0), bytes.count)
        while index > 0, bytes[index] & 0xC0 == 0x80 { index -= 1 }
        return index
    }

    /// The largest suffix length that starts on a UTF-8 boundary.
    nonisolated private static func boundaryFromEnd(_ bytes: [UInt8], upTo count: Int) -> Int {
        var index = min(max(count, 0), bytes.count)
        while index > 0, bytes[bytes.count - index] & 0xC0 == 0x80 { index -= 1 }
        return index
    }
}
