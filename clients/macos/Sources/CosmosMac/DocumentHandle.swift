import Foundation

/// Naming the document the owner is looking at, so that "continue on my PC"
/// has something to resolve.
///
/// When the owner attaches what is on their screen, this Mac can also say
/// *which document that screen is*: where it lives, which version of it, and
/// where in it the owner was. What travels is a locator, a digest and a place —
/// never the bytes, never the captured text, and never anything that reaches
/// cognition. The label exists for the owner to read here.
///
/// Everything about it is honest or absent:
///
/// * A file is named only as a path under a root the owner declared in their
///   own device-action policy, because the destination resolves that same root
///   id under its own paths. A document under no declared root is not named at
///   all; it is never approximated by an absolute path.
/// * A file is named only with the SHA-256 of its own bytes, because the
///   destination hashes the file it finds and refuses to open a document that
///   changed underneath. A file this Mac cannot hash is not named.
/// * A web page is named only on a host the owner declared, with the page's own
///   fragment as the place.
/// * A place this Mac cannot read is left out. No position at all is better
///   than a wrong one, and a kind of place the locator cannot carry — a
///   fragment in a file, a line in a web page — is dropped rather than sent to
///   be refused.

// MARK: Where in a document

/// Where in a document the owner is: a line in text, a page in a paged
/// document, a named fragment in a web page. The bounds are the runtime's own,
/// so a position this Mac sends is one the runtime and the destination accept.
public enum DocumentPosition: Equatable, Sendable {
    case line(Int)
    case page(Int)
    case fragment(String)

    public static let lines = 1...1_000_000
    public static let pages = 1...100_000
    public static let maximumFragmentBytes = 200

    public var valid: Bool {
        switch self {
        case .line(let line): Self.lines.contains(line)
        case .page(let page): Self.pages.contains(page)
        case .fragment(let value): DevicePolicy.text(value, maximum: Self.maximumFragmentBytes)
        }
    }

    var wire: [String: Any] {
        switch self {
        case .line(let line): ["kind": "line", "line": line]
        case .page(let page): ["kind": "page", "page": page]
        case .fragment(let value): ["kind": "fragment", "value": value]
        }
    }

    /// What the owner reads next to the document's name.
    public var caption: String {
        switch self {
        case .line(let line): "line \(line)"
        case .page(let page): "page \(page)"
        case .fragment(let value): "#\(value)"
        }
    }

    /// What a log may carry: the kind, and a number when the place is one. A
    /// fragment is the page's own text and stays out of it.
    var summary: String {
        switch self {
        case .line(let line): "line \(line)"
        case .page(let page): "page \(page)"
        case .fragment: "fragment"
        }
    }
}

// MARK: Which document

/// Which document, in the two shapes this Mac can name honestly. An
/// application is not a document, so there is no `app` case here.
public enum DocumentLocator: Equatable, Sendable {
    case file(rootID: String, relative: String)
    case https(url: String)

    public static let maximumRootIDBytes = 32
    public static let maximumRelativeBytes = 512

    public var valid: Bool {
        switch self {
        case .file(let rootID, let relative):
            DevicePolicy.token(rootID, maximum: Self.maximumRootIDBytes)
                && !relative.isEmpty && relative.utf8.count <= Self.maximumRelativeBytes
                && !relative.hasPrefix("/") && !relative.contains("\\")
                && !relative.contains(where: \.isControlCharacter)
                && relative.split(separator: "/", omittingEmptySubsequences: false)
                    .allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
        case .https(let url):
            DevicePolicy.webURL(url) != nil
        }
    }

    var wire: [String: Any] {
        switch self {
        case .file(let rootID, let relative):
            ["scheme": "file", "rootId": rootID, "relative": relative]
        case .https(let url):
            ["scheme": "https", "url": url]
        }
    }

    var summary: String {
        switch self {
        case .file(let rootID, _): "file root=\(rootID)"
        case .https(let url): "https host=\(DevicePolicy.webURL(url)?.host?.lowercased() ?? "?")"
        }
    }
}

// MARK: The handle itself

/// The document the origin was looking at, as the runtime holds it. It carries
/// no bytes and no screen text.
public struct DocumentHandle: Equatable, Sendable {
    public static let maximumAppBytes = 64
    public static let maximumLabelBytes = 120

    /// This Mac's own name for the application the document is open in.
    public let app: String
    public let locator: DocumentLocator
    /// The SHA-256 of the file's own bytes, 64 lowercase hex digits.
    public let version: String?
    public let position: DocumentPosition?
    /// What a person calls this document. It is shown to the owner and is never
    /// part of a prompt.
    public let label: String

    public init(app: String, locator: DocumentLocator, version: String? = nil,
                position: DocumentPosition? = nil, label: String) {
        self.app = app
        self.locator = locator
        self.version = version
        self.position = position
        self.label = label
    }

    /// Exactly the runtime's own `DocumentHandle::valid()`. Nothing that fails
    /// this is ever attached to a request.
    public var valid: Bool {
        DevicePolicy.text(app, maximum: Self.maximumAppBytes)
            && locator.valid
            && (version.map(Self.digest) ?? true)
            && (position.map(\.valid) ?? true)
            && DevicePolicy.text(label, maximum: Self.maximumLabelBytes)
    }

    /// The compact JSON the runtime deserializes, field for field. It rejects
    /// unknown fields, so this object carries these five and nothing else.
    public func encoded() -> Data {
        var object: [String: Any] = ["app": app, "locator": locator.wire, "label": label]
        if let version { object["version"] = version }
        if let position { object["position"] = position.wire }
        return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    /// One content-free line for the app's own log: which root, that there is a
    /// version, and what kind of place. Never the path, the label or a fragment.
    public var summary: String {
        var parts = [locator.summary]
        if let version { parts.append("version=\(version.prefix(8))…") }
        if let position { parts.append("position=\(position.summary)") }
        return parts.joined(separator: " ")
    }

    static func digest(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { $0.isASCII && ($0.isNumber || ("a"..."f").contains($0)) }
    }
}

// MARK: What the frontmost application said

/// What the application the owner was using says it is showing, before any of
/// the owner's policy is applied to it. It is read through the same
/// Accessibility permission the selection needs and nothing else; the document
/// itself is never opened or read.
public struct DocumentObservation: Equatable, Sendable {
    public enum Subject: Equatable, Sendable {
        /// An absolute path on this Mac, as the application reported it.
        case file(path: String)
        case web(url: String)
    }

    public let subject: Subject
    /// Where the application says the owner is, when it says at all.
    public let position: DocumentPosition?
    /// What that application calls it: a file name, a page title.
    public let label: String

    public init(subject: Subject, position: DocumentPosition? = nil, label: String) {
        self.subject = subject
        self.position = position
        self.label = label
    }
}

/// A file this Mac may name: the owner's root, the path under it, and where the
/// file actually is here.
public struct LocatedDocument: Equatable, Sendable {
    public let rootID: String
    public let relative: String
    public let path: String
}

// MARK: Naming it

public enum DocumentNaming {
    /// The declared root this path lies under, and the path under it. Nil when
    /// no root the owner declared contains it — which is the ordinary answer for
    /// most of what is open on a Mac, and is never a reason to send something
    /// looser instead.
    ///
    /// Both sides are fully resolved before they are compared, so a symlink out
    /// of a root is out of it. The most specific root wins, because a nested
    /// root is the one the owner declared for this document.
    public static func locate(_ path: String, roots: [DeviceRoot],
                              filesystem: Filesystem = .real) -> LocatedDocument? {
        guard let resolved = filesystem.resolve(path), resolved.hasPrefix("/") else { return nil }
        var found: LocatedDocument?
        var foundBaseLength = 0
        for root in roots {
            guard DevicePolicy.token(root.id, maximum: DocumentLocator.maximumRootIDBytes),
                  let base = filesystem.resolve(root.path), base.hasPrefix("/") else { continue }
            let prefix = base == "/" ? "/" : base + "/"
            guard resolved.hasPrefix(prefix), resolved != base else { continue }
            let relative = String(resolved.dropFirst(prefix.count))
            // The destination resolves the pair its own way. Only a pair that
            // resolves back to this very file here is worth sending, so the one
            // containment check this Mac already has decides it.
            guard case .success(let round) = DevicePolicy.contain(relative, under: root,
                                                                  filesystem: filesystem),
                  round == resolved else { continue }
            guard DocumentLocator.file(rootID: root.id, relative: relative).valid else { continue }
            if found == nil || base.utf8.count > foundBaseLength {
                found = LocatedDocument(rootID: root.id, relative: relative, path: resolved)
                foundBaseLength = base.utf8.count
            }
        }
        return found
    }

    /// The page as a locator, with its own fragment split off as the place.
    /// Nil unless the owner declared this host for this Mac.
    public static func web(_ value: String, hosts: [String]) -> (url: String, fragment: String?)? {
        guard let url = DevicePolicy.webURL(value), let host = url.host?.lowercased(),
              hosts.contains(host), var components = URLComponents(string: value) else { return nil }
        let fragment = components.fragment
        components.fragment = nil
        guard let stripped = components.string, DevicePolicy.webURL(stripped) != nil else { return nil }
        return (stripped, fragment)
    }

    /// The one handle for one observation, or nil when nothing about it can be
    /// named honestly. Holding no policy names nothing at all.
    public static func handle(for observation: DocumentObservation?, app: String,
                              policy: DevicePolicy?, filesystem: Filesystem = .real) -> DocumentHandle? {
        guard let observation, let policy else { return nil }
        let app = bounded(app, maximum: DocumentHandle.maximumAppBytes) ?? ContextChip.unknownApp
        let handle: DocumentHandle
        switch observation.subject {
        case .file(let path):
            guard let located = locate(path, roots: policy.roots, filesystem: filesystem),
                  // Like against like: the destination hashes the file's own
                  // bytes. One this Mac cannot hash is one it cannot promise.
                  let version = filesystem.digest(located.path),
                  let label = label(observation.label,
                                    fallback: located.relative.split(separator: "/").last.map(String.init))
            else { return nil }
            handle = DocumentHandle(app: app,
                                    locator: .file(rootID: located.rootID, relative: located.relative),
                                    version: version, position: place(observation.position, inFile: true),
                                    label: label)
        case .web(let value):
            guard let located = web(value, hosts: policy.hosts),
                  let label = label(observation.label,
                                    fallback: DevicePolicy.webURL(located.url)?.host) else { return nil }
            let position = place(observation.position, inFile: false)
                ?? located.fragment.map(DocumentPosition.fragment).flatMap { $0.valid ? $0 : nil }
            // A page has no version this Mac can honestly state: it holds no
            // ETag, and hashing what a browser rendered is not the document.
            handle = DocumentHandle(app: app, locator: .https(url: located.url),
                                    position: position, label: label)
        }
        return handle.valid ? handle : nil
    }

    /// A place is kept only where the locator can carry it: a line or a page in
    /// a file, a fragment in a page. The rest is dropped here rather than
    /// refused at the destination.
    private static func place(_ position: DocumentPosition?, inFile: Bool) -> DocumentPosition? {
        guard let position, position.valid else { return nil }
        switch position {
        case .line, .page: return inFile ? position : nil
        case .fragment: return inFile ? nil : position
        }
    }

    private static func label(_ value: String, fallback: String?) -> String? {
        if let bounded = bounded(value, maximum: DocumentHandle.maximumLabelBytes) { return bounded }
        return fallback.flatMap { bounded($0, maximum: DocumentHandle.maximumLabelBytes) }
    }

    /// Bounded, with the control characters the wire refuses taken out first, so
    /// a long file name is shortened instead of being dropped.
    private static func bounded(_ value: String, maximum: Int) -> String? {
        let clean = value.filter { !$0.isControlCharacter }
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return nil }
        let cut = ContextChip.bounded(clean, to: maximum).text
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return DevicePolicy.text(cut, maximum: maximum) ? cut : nil
    }
}
