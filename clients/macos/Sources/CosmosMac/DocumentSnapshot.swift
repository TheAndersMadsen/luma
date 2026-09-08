import Darwin
import Foundation

/// The destination's immutable text bytes and position. It retains no path,
/// opens no links and carries no authority to read or transfer source content.
public struct DocumentSnapshot: Equatable, Sendable, CustomDebugStringConvertible {
    public static let maximumBytes = 256 * 1024
    public let text: String
    public let digest: String
    public let line: UInt32
    public let cursor: Int

    public var debugDescription: String { "DocumentSnapshot([REDACTED])" }

    public init(bytes: Data, version: String, position: DevicePosition?, explanation: String = "") throws {
        guard bytes.count <= Self.maximumBytes else { throw ActionRefusal.noHandler }
        let digest = CanonicalJSON.hexDigest(bytes)
        guard digest == version else { throw ActionRefusal.versionChanged }
        guard let decoded = String(data: bytes, encoding: .utf8) else { throw ActionRefusal.noHandler }
        let text = decoded.replacingOccurrences(of: "\r\n", with: "\n")
        let explanation = explanation.replacingOccurrences(of: "\r\n", with: "\n")
        guard explanation.utf8.count <= 2000, !(text + explanation).unicodeScalars.contains(where: {
            ($0.value < 32 && $0 != "\t" && $0 != "\n") || [0x7f, 0x2028, 0x2029].contains($0.value)
        }) else { throw ActionRefusal.noHandler }
        let line: UInt32
        switch position {
        case .none: line = 1
        case .line(let value): line = value
        default: throw ActionRefusal.noHandler
        }
        let lines = text.components(separatedBy: "\n")
        guard line > 0, line <= lines.count else { throw ActionRefusal.unresolvable }
        let prefix = lines.prefix(Int(line) - 1).joined(separator: "\n") + (line > 1 ? "\n" : "")
        let introduction = explanation.isEmpty ? "" : explanation + "\n\n"
        self.text = introduction + text
        self.digest = digest
        self.line = line
        self.cursor = introduction.utf16.count + prefix.utf16.count
    }

    /// A policy-resolved regular file is read once, without mapping mutable
    /// file pages into the viewer. The digest covers these retained bytes.
    public static func read(path: String, version: String, position: DevicePosition?) throws -> Self {
        let descriptor = Darwin.open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw ActionRefusal.unresolvable }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG else {
            throw ActionRefusal.unresolvable
        }
        guard info.st_size <= maximumBytes else { throw ActionRefusal.noHandler }
        let bytes: Data
        do { bytes = try handle.read(upToCount: maximumBytes + 1) ?? Data() }
        catch { throw ActionRefusal.unresolvable }
        return try Self(bytes: bytes, version: version, position: position)
    }
}

/// Content identity and selected audience; these are not filesystem paths.
public struct DocumentReference: Decodable, Equatable, Sendable {
    public let id: UUID
    public let digest: String
    public let expiresAtMs: Int64
    public let audience: UUID
}

/// The shared client has checked the connection and command. This shell also
/// checks the immutable text, explanation and task binding before retaining it.
public struct DocumentTransfer: Codable, Equatable, Sendable, CustomDebugStringConvertible {
    public let kind: String
    public let text: String
    public let explanation: String
    public let version: String
    public let taskId: UUID
    public let revision: UInt64
    public var debugDescription: String { "DocumentTransfer([REDACTED])" }

    public var digest: String {
        CanonicalJSON.digest(.array([
            .string("cosmos.document-snapshot"), .integer(1), .string(text), .string(explanation),
            .string(version), .string(taskId.uuidString.lowercased()), .string(String(revision)),
        ]))
    }

    public func matches(operation: DeviceOperation, turnID: UUID, revision: UInt64, expiresAtMs: Int64) -> Bool {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        guard case .open(.snapshot(let root, let content), let expected, let position, _) = operation,
              kind == "document", taskId == turnID, self.revision == revision,
              DevicePolicy.token(root, maximum: 32), expected == version,
              content.id != DisplayCard.nilUUID, content.audience != DisplayCard.nilUUID,
              content.expiresAtMs == expiresAtMs, content.digest == digest,
              text.utf8.count <= 8000, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              explanation.utf8.count <= 2000,
              let wire = try? encoder.encode(self), wire.count <= 8192,
              (try? DocumentSnapshot(bytes: Data(text.utf8), version: version,
                                     position: position, explanation: explanation)) != nil else { return false }
        return true
    }
}

public struct DocumentPresentation: Equatable, Sendable {
    public let task: DeviceTask
    public let content: DocumentSnapshot
}
