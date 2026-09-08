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

    public init(bytes: Data, version: String, position: DevicePosition?) throws {
        guard bytes.count <= Self.maximumBytes else { throw ActionRefusal.noHandler }
        let digest = CanonicalJSON.hexDigest(bytes)
        guard digest == version else { throw ActionRefusal.versionChanged }
        guard let decoded = String(data: bytes, encoding: .utf8) else { throw ActionRefusal.noHandler }
        let text = decoded.replacingOccurrences(of: "\r\n", with: "\n")
        guard !text.unicodeScalars.contains(where: {
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
        self.text = text
        self.digest = digest
        self.line = line
        self.cursor = prefix.utf16.count
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

public struct DocumentPresentation: Equatable, Sendable {
    public let task: DeviceTask
    public let content: DocumentSnapshot
}
