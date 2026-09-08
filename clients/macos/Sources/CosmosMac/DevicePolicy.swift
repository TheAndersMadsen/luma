import CryptoKit
import Darwin
import Foundation

/// This installation's own copy of the owner's device-action policy, and the
/// verification every command passes before anything happens on this Mac.
///
/// The copy is the owner's own statement, written once in Center and delivered
/// by Cosmos over the connection this Mac already holds, bound to the surface
/// and the approval revision that connection was opened at. Delivery is not
/// authority: it is a cache of one revision, it is never written to disk, it is
/// dropped with the connection that carried it, and an installation holding
/// none does nothing at all.
///
/// Nothing here trusts what Cosmos said afterwards. The runtime sends an entry
/// id and two digests; the argv comes from this copy and from nowhere else. A
/// host, an application, a root or a task that is not written here is refused,
/// whatever arrived on the wire.

// MARK: Canonical JSON

/// The exact compact serialization the whole fleet hashes, byte-for-byte:
/// no spaces, integers as integers, absent optionals as null, non-ASCII raw.
/// `contracts/fixtures/ambiance-device-action-digests-v1.json` pins it and this
/// Mac asserts against that file, so a drift refuses commands instead of
/// running something the owner never approved.
public enum CanonicalJSON {
    public indirect enum Value: Equatable, Sendable {
        case string(String)
        case integer(Int64)
        case boolean(Bool)
        case null
        case array([Value])
    }

    public static func encode(_ value: Value) -> String {
        switch value {
        case .null: return "null"
        case .boolean(let flag): return flag ? "true" : "false"
        case .integer(let number): return String(number)
        case .string(let text): return quoted(text)
        case .array(let items): return "[" + items.map(encode).joined(separator: ",") + "]"
        }
    }

    public static func digest(_ value: Value) -> String {
        hexDigest(Data(encode(value).utf8))
    }

    public static func hexDigest(_ bytes: Data) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }

    /// Only the two structural characters and the C0 controls are escaped, and
    /// the short forms are used where they exist. Everything else, including
    /// every non-ASCII scalar and the solidus, is written through unchanged.
    private static func quoted(_ text: String) -> String {
        var output = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": output += "\\\""
            case "\\": output += "\\\\"
            case "\u{08}": output += "\\b"
            case "\u{09}": output += "\\t"
            case "\u{0A}": output += "\\n"
            case "\u{0C}": output += "\\f"
            case "\u{0D}": output += "\\r"
            default:
                if scalar.value < 0x20 {
                    output += String(format: "\\u%04x", scalar.value)
                } else {
                    output.unicodeScalars.append(scalar)
                }
            }
        }
        return output + "\""
    }
}

// MARK: The owner's entries

/// One directory the owner declared this Mac may open files under.
public struct DeviceRoot: Equatable, Sendable {
    public let id: String
    public let label: String
    public let path: String

    public init(id: String, label: String, path: String) {
        self.id = id
        self.label = label
        self.path = path
    }
}

/// One application the owner declared this Mac may open.
public struct DeviceApp: Equatable, Sendable {
    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }
}

/// One command the owner authored in Center. `argv` is a fixed array: there is
/// no shell, no interpolation and no parameter at any risk level.
public struct CommandEntry: Equatable, Sendable {
    public let id: String
    public let label: String
    public let argv: [String]
    public let cwd: String
    public let mutates: Bool
    public let budgetMs: Int64

    public init(id: String, label: String, argv: [String], cwd: String, mutates: Bool, budgetMs: Int64) {
        self.id = id
        self.label = label
        self.argv = argv
        self.cwd = cwd
        self.mutates = mutates
        self.budgetMs = budgetMs
    }

    /// What this Mac must find in its own copy before it spawns anything.
    public var argvDigest: String {
        CanonicalJSON.digest(.array([
            .string("cosmos.device-command.argv"), .integer(1),
            .array(argv.map(CanonicalJSON.Value.string)), .string(cwd),
        ]))
    }

    /// The whole entry, so an owner editing it between the decision and the
    /// dispatch invalidates the command instead of changing what runs.
    public var entryDigest: String {
        CanonicalJSON.digest(.array([
            .string("cosmos.device-command.entry"), .integer(1),
            .string(id), .string(label), .string(argvDigest),
            .boolean(mutates), .integer(budgetMs),
        ]))
    }

    /// The same bounds Cosmos applies when the owner writes the entry. An entry
    /// this Mac cannot vouch for is not kept at all.
    public var wellFormed: Bool {
        DevicePolicy.token(id, maximum: 48)
            && DevicePolicy.text(label, maximum: 120)
            && (1...12).contains(argv.count)
            && argv.allSatisfy { !$0.isEmpty && $0.utf8.count <= 256 && !$0.contains(where: \.isControlCharacter) }
            && cwd.hasPrefix("/") && DevicePolicy.text(cwd, maximum: 256)
            && !cwd.split(separator: "/", omittingEmptySubsequences: false).contains("..")
            && !argv[0].split(separator: "/", omittingEmptySubsequences: false).contains("..")
            && (1...900_000).contains(budgetMs)
    }
}

// MARK: Refusals

/// Why this Mac declined, in the runtime's own closed vocabulary. A refusal is
/// always reported: silence is never an answer.
public enum ActionRefusal: String, Error, Equatable, Sendable, CaseIterable {
    case noHandler = "no_handler"
    case locked
    case notPermitted = "not_permitted"
    case unresolvable
    case versionChanged = "version_changed"
    case entryChanged = "entry_changed"
    case noAttestation = "no_attestation"
}

/// What this Mac will actually do, once the command has passed every check.
/// Every path here is absolute and already resolved; no string is built later.
public enum PlannedAction: Equatable, Sendable {
    case openLink(URL)
    case openFile(URL)
    case showDocument(DocumentSnapshot)
    case openApplication(bundleID: String)
    case run(CommandEntry)

    public var isRun: Bool { if case .run = self { return true }; return false }
}

// MARK: The filesystem this Mac checks against

/// The two filesystem questions containment asks, injected so the checks are
/// exercised against real directories and real symlinks in the tests.
public struct Filesystem: Sendable {
    /// The fully resolved absolute path, following every symlink, or nil.
    public var resolve: @Sendable (String) -> String?
    /// The SHA-256 of a regular file's bytes, or nil when it cannot be read.
    public var digest: @Sendable (String) -> String?

    public init(resolve: @escaping @Sendable (String) -> String?,
                digest: @escaping @Sendable (String) -> String?) {
        self.resolve = resolve
        self.digest = digest
    }

    /// The largest file this Mac will hash to check a document version.
    public static let maximumDigestBytes = 64 * 1024 * 1024

    public static let real = Filesystem(
        resolve: { path in
            guard let resolved = realpath(path, nil) else { return nil }
            defer { free(resolved) }
            return String(cString: resolved)
        },
        digest: { path in
            var info = stat()
            guard lstat(path, &info) == 0 || stat(path, &info) == 0 else { return nil }
            guard stat(path, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
                  info.st_size <= Filesystem.maximumDigestBytes,
                  let handle = FileHandle(forReadingAtPath: path) else { return nil }
            defer { try? handle.close() }
            var hasher = SHA256()
            while let chunk = try? handle.read(upToCount: 1 << 20), !chunk.isEmpty {
                hasher.update(data: chunk)
            }
            return hasher.finalize().map { String(format: "%02x", $0) }.joined()
        }
    )
}

// MARK: The policy

/// The owner's own list, as this installation holds it. Holding none at all is
/// a perfectly ordinary state: this Mac then does nothing and says so.
public struct DevicePolicy: Equatable, Sendable {
    public let hosts: [String]
    public let apps: [DeviceApp]
    public let roots: [DeviceRoot]
    public let entries: [CommandEntry]

    public init(hosts: [String] = [], apps: [DeviceApp] = [],
                roots: [DeviceRoot] = [], entries: [CommandEntry] = []) {
        self.hosts = hosts
        self.apps = apps
        self.roots = roots
        self.entries = entries
    }

    public var isEmpty: Bool { hosts.isEmpty && apps.isEmpty && roots.isEmpty && entries.isEmpty }

    public func entry(_ id: String) -> CommandEntry? { entries.first { $0.id == id } }
    public func root(_ id: String) -> DeviceRoot? { roots.first { $0.id == id } }

    /// The whole document, exactly as the runtime bounds it before it commits
    /// one. A larger policy is refused where the owner writes it, so a
    /// truncated allowlist never reaches this Mac.
    public static let maximumBytes = 8 * 1024
    /// The classes the owner can spend. `maximumClass` is a ceiling they
    /// already spent; a copy can never raise it.
    static let classes = ["public", "shared_room", "near_user", "private"]

    /// The delivered copy, read against what the snapshot said it is.
    ///
    /// The bytes have to be the exact document the snapshot named — its length
    /// and its SHA-256 — and it has to be the owner's statement about *this*
    /// connection: another surface or another approval revision is somebody
    /// else's permission and is never held here. Every section is then checked
    /// field by field against the bounds the runtime itself applies when the
    /// owner saves it, because half an allowlist is worse than none: anything
    /// out of shape anywhere refuses the whole document and this Mac then holds
    /// nothing at all.
    public static func decode(_ data: Data, held: HeldPolicy) -> DevicePolicy? {
        guard data.count == held.byteLength, !data.isEmpty, data.count <= maximumBytes,
              CanonicalJSON.hexDigest(data) == held.digest,
              let parsed = try? JSONSerialization.jsonObject(with: data),
              let document = parsed as? [String: Any],
              Set(document.keys).isSubset(of: ["version", "surfaceId", "approvalRevision",
                                               "actions", "commands"]),
              document["version"] as? Int == 1,
              (document["surfaceId"] as? String).flatMap(UUID.init(uuidString:)) == held.surfaceID,
              number(document["approvalRevision"]) == held.approvalRevision,
              // A section is present exactly where the snapshot named its revision.
              (document["actions"] != nil) == (held.actionsRevision != nil),
              (document["commands"] != nil) == (held.commandsRevision != nil) else {
            return nil
        }
        var hosts: [String] = []
        var apps: [DeviceApp] = []
        var roots: [DeviceRoot] = []
        var entries: [CommandEntry] = []

        if let revision = held.actionsRevision {
            // This Mac's manifest declares neither navigation nor a player, so
            // the runtime never sends `route` or `play` here; a document that
            // carries one is not this installation's permission.
            guard let actions = document["actions"] as? [String: Any],
                  Set(actions.keys) == ["revision", "maximumClass", "open"],
                  number(actions["revision"]) == revision,
                  classes.contains(actions["maximumClass"] as? String ?? ""),
                  let open = actions["open"] as? [String: Any],
                  Set(open.keys).isSubset(of: ["hosts", "apps", "roots"]) else { return nil }
            if let listed = open["hosts"] {
                guard let listed = listed as? [String] else { return nil }
                hosts = listed
            }
            // Hosts arrive sorted and without repeats.
            guard zip(hosts, hosts.dropFirst()).allSatisfy({ $0 < $1 }) else { return nil }
            if let listed = open["apps"] {
                guard let listed = listed as? [Any] else { return nil }
                for value in listed {
                    guard let entry = value as? [String: Any], Set(entry.keys) == ["id", "label"],
                          let id = entry["id"] as? String,
                          let label = entry["label"] as? String else { return nil }
                    apps.append(DeviceApp(id: id, label: label))
                }
            }
            if let listed = open["roots"] {
                guard let listed = listed as? [Any] else { return nil }
                for value in listed {
                    guard let entry = value as? [String: Any],
                          Set(entry.keys) == ["id", "label", "path"],
                          let id = entry["id"] as? String, let label = entry["label"] as? String,
                          let path = entry["path"] as? String else { return nil }
                    roots.append(DeviceRoot(id: id, label: label, path: path))
                }
            }
            // A section the owner left empty is not delivered at all.
            guard !hosts.isEmpty || !apps.isEmpty || !roots.isEmpty else { return nil }
        }

        if let revision = held.commandsRevision {
            guard let commands = document["commands"] as? [String: Any],
                  Set(commands.keys) == ["revision", "maximumClass", "offerOutputToCognition", "entries"],
                  number(commands["revision"]) == revision,
                  classes.contains(commands["maximumClass"] as? String ?? ""),
                  boolean(commands["offerOutputToCognition"]) != nil,
                  let listed = commands["entries"] as? [Any],
                  (1...8).contains(listed.count) else { return nil }
            for value in listed {
                guard let entry = value as? [String: Any],
                      Set(entry.keys) == ["id", "label", "argv", "cwd", "mutates", "budgetMs"],
                      let id = entry["id"] as? String, let label = entry["label"] as? String,
                      let argv = entry["argv"] as? [String], let cwd = entry["cwd"] as? String,
                      let mutates = boolean(entry["mutates"]),
                      let budget = number(entry["budgetMs"]).flatMap({ Int64(exactly: $0) }) else { return nil }
                entries.append(CommandEntry(id: id, label: label, argv: argv, cwd: cwd,
                                            mutates: mutates, budgetMs: budget))
            }
        }

        let policy = DevicePolicy(hosts: hosts, apps: apps, roots: roots, entries: entries)
        return policy.wellFormed ? policy : nil
    }

    /// A whole number as JSON writes one. A boolean is not a number here, so a
    /// `true` never passes for a revision or a budget.
    static func number(_ value: Any?) -> UInt64? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.int64Value >= 0, Double(value.int64Value) == value.doubleValue else { return nil }
        return UInt64(value.int64Value)
    }

    static func boolean(_ value: Any?) -> Bool? {
        guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
        return value.boolValue
    }

    /// Exactly the caps Cosmos applies at policy-write time. This Mac holds a
    /// copy, so it holds the copy to the same shape.
    public var wellFormed: Bool {
        hosts.count <= 16 && hosts.allSatisfy(Self.declaredHost)
            && apps.count <= 8 && apps.allSatisfy { Self.bundleIdentifier($0.id) && Self.text($0.label, maximum: 120) }
            && roots.count <= 4 && roots.allSatisfy {
                Self.token($0.id, maximum: 32) && Self.text($0.label, maximum: 120)
                    && $0.path.hasPrefix("/") && Self.text($0.path, maximum: 256)
                    && !$0.path.split(separator: "/", omittingEmptySubsequences: false).contains("..")
            }
            && entries.count <= 8 && entries.allSatisfy(\.wellFormed)
            && Set(apps.map(\.id)).count == apps.count
            && Set(roots.map(\.id)).count == roots.count
            && Set(entries.map(\.id)).count == entries.count
            && Set(hosts).count == hosts.count
    }

    // MARK: Re-verification

    /// The whole local check, in one place: an operation this Mac cannot carry
    /// out, a host or application the owner never listed, a root this
    /// installation does not have, a path that leaves it, a document that
    /// changed, an unknown entry or an argv digest that does not match are each
    /// a refusal with its own reason. Only a command that passes all of this is
    /// ever acknowledged.
    public func plan(_ operation: DeviceOperation,
                     filesystem: Filesystem = .real) -> Result<PlannedAction, ActionRefusal> {
        switch operation {
        case .unsupported:
            // macOS declares neither route nor play; nothing here can carry one out.
            return .failure(.noHandler)
        case .open(let locator, let version, let position, _):
            return plan(locator, version: version, position: position, filesystem: filesystem)
        case .run(let entryID, _, let entryDigest, let argvDigest, _, _):
            guard let entry = entry(entryID) else { return .failure(.notPermitted) }
            // The argv is this file's, keyed by id. The digests only prove the
            // owner's entry is still the one Cosmos bound.
            guard entry.argvDigest == argvDigest, entry.entryDigest == entryDigest else {
                return .failure(.entryChanged)
            }
            return .success(.run(entry))
        }
    }

    private func plan(_ locator: DeviceLocator, version: String?, position: DevicePosition?,
                      filesystem: Filesystem) -> Result<PlannedAction, ActionRefusal> {
        switch locator {
        case .https(let value):
            guard version == nil else { return .failure(.versionChanged) }
            guard let url = Self.webURL(value), let host = url.host?.lowercased() else {
                return .failure(.unresolvable)
            }
            guard hosts.contains(host) else { return .failure(.notPermitted) }
            if let position {
                guard case .fragment(let fragment) = position,
                      var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
                    return .failure(.noHandler)
                }
                parts.fragment = fragment
                guard let target = parts.url else { return .failure(.unresolvable) }
                return .success(.openLink(target))
            }
            return .success(.openLink(url))
        case .app(let id):
            guard apps.contains(where: { $0.id == id }) else { return .failure(.notPermitted) }
            guard version == nil, position == nil else { return .failure(.noHandler) }
            return .success(.openApplication(bundleID: id))
        case .file(let rootID, let relative):
            guard let root = root(rootID) else { return .failure(.unresolvable) }
            switch Self.contain(relative, under: root, filesystem: filesystem) {
            case .failure(let refusal): return .failure(refusal)
            case .success(let path):
                if let version {
                    do { return .success(.showDocument(try DocumentSnapshot.read(
                        path: path, version: version, position: position))) }
                    catch let reason as ActionRefusal { return .failure(reason) }
                    catch { return .failure(.unresolvable) }
                }
                guard position == nil else { return .failure(.noHandler) }
                return .success(.openFile(URL(fileURLWithPath: path)))
            }
        }
    }

    /// Containment, done the only way that holds: resolve both sides fully and
    /// compare the resolved paths. A symlink inside the root that points out of
    /// it resolves out of it, so it is refused like any other escape.
    public static func contain(_ relative: String, under root: DeviceRoot,
                               filesystem: Filesystem = .real) -> Result<String, ActionRefusal> {
        guard !relative.isEmpty, relative.utf8.count <= 512, !relative.hasPrefix("/"),
              !relative.contains("\\"), !relative.contains(where: \.isControlCharacter),
              relative.split(separator: "/", omittingEmptySubsequences: false)
                  .allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            return .failure(.notPermitted)
        }
        guard let base = filesystem.resolve(root.path), base.hasPrefix("/") else {
            return .failure(.unresolvable)
        }
        guard let resolved = filesystem.resolve(base + "/" + relative) else { return .failure(.unresolvable) }
        let prefix = base == "/" ? "/" : base + "/"
        guard resolved.hasPrefix(prefix), resolved != base else { return .failure(.notPermitted) }
        return .success(resolved)
    }

    // MARK: Shape

    static func text(_ value: String, maximum: Int) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && value.utf8.count <= maximum && !value.contains(where: \.isControlCharacter)
    }

    static func token(_ value: String, maximum: Int) -> Bool {
        !value.isEmpty && value.utf8.count <= maximum
            && value.allSatisfy { ($0.isLowercase && $0.isASCII) || $0.isNumber && $0.isASCII || $0 == "-" }
    }

    /// An `https` URL that can be opened without ambiguity, in the runtime's own
    /// shape: no userinfo, no port, no whitespace and no backslash. One
    /// statement of it, for the command this Mac carries out and for the page it
    /// names as a document.
    public static let maximumURLBytes = 2048
    public static func webURL(_ value: String) -> URL? {
        guard !value.isEmpty, value.utf8.count <= maximumURLBytes, !value.contains("\\"),
              !value.contains(where: { $0.isWhitespace || $0.isControlCharacter }),
              let url = URL(string: value), url.scheme?.lowercased() == "https",
              url.host?.isEmpty == false, url.user == nil, url.password == nil,
              url.port == nil else { return nil }
        return url
    }

    static func declaredHost(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 253 && value == value.lowercased()
            && !value.hasPrefix(".") && !value.hasSuffix(".") && !value.contains("..")
            && value.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "." || $0 == "-" }
            && value.contains(".")
    }

    static func bundleIdentifier(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 128 && !value.hasPrefix(".") && !value.hasSuffix(".")
            && value.allSatisfy { ($0.isASCII && ($0.isLetter || $0.isNumber)) || $0 == "." || $0 == "-" || $0 == "_" }
    }

}

extension Character {
    var isControlCharacter: Bool {
        unicodeScalars.contains { $0.properties.generalCategory == .control }
    }
}
