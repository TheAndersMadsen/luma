import Darwin
import Foundation

/// Complete bytes from one explicitly chosen saved file, retained until Send.
/// Selection capture cannot substitute for this file's exact version.
public struct SavedFileAttachment: Sendable {
    public let context: ContextChip
    public let document: DocumentHandle

    public enum Failure: String, Error, Sendable {
        case permission = "Choose a file inside a document folder allowed for this Mac in Center."
        case unavailable = "The selected file could not be read. Check its access and attach it again."
        case size = "This attachment supports complete text files up to 8,000 bytes."
        case changed = "The file changed while it was read. Attach it again."
        case content = "Choose a UTF-8 text file with a short filename and no control characters."
        case empty = "The selected file holds no text."
        case wire = "This file is too large for a complete document transfer."
    }

    public static func read(url: URL, policy: DevicePolicy?) throws -> Self {
        guard url.isFileURL, let policy,
              let located = DocumentNaming.locate(url.path, roots: policy.roots),
              let root = policy.root(located.rootID), let base = Filesystem.real.resolve(root.path)
        else { throw Failure.permission }
        let flags = O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC
        var descriptor = Darwin.open("/", flags | O_DIRECTORY)
        guard descriptor >= 0 else { throw Failure.unavailable }
        defer { Darwin.close(descriptor) }
        let parts = base.split(separator: "/") + located.relative.split(separator: "/")
        for (index, part) in parts.enumerated() {
            let child = openat(descriptor, String(part), flags | (index < parts.count - 1 ? O_DIRECTORY : 0))
            guard child >= 0 else { throw Failure.unavailable }
            Darwin.close(descriptor)
            descriptor = child
        }
        var before = stat()
        guard fstat(descriptor, &before) == 0, before.st_mode & S_IFMT == S_IFREG else { throw Failure.unavailable }
        guard before.st_size <= ContextChip.maximumBytes else { throw Failure.size }
        var bytes = Data()
        var buffer = [UInt8](repeating: 0, count: ContextChip.maximumBytes + 1)
        while bytes.count <= ContextChip.maximumBytes {
            let count = Darwin.read(descriptor, &buffer, ContextChip.maximumBytes + 1 - bytes.count)
            guard count >= 0 else { throw Failure.unavailable }
            if count == 0 { break }
            bytes.append(contentsOf: buffer.prefix(count))
        }
        var after = stat()
        guard fstat(descriptor, &after) == 0,
              before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
              before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec else { throw Failure.changed }
        guard bytes.count <= ContextChip.maximumBytes else { throw Failure.size }
        let version = CanonicalJSON.hexDigest(bytes)
        guard let text = String(data: bytes, encoding: .utf8),
              DevicePolicy.text(url.lastPathComponent, maximum: DocumentHandle.maximumLabelBytes),
              (try? DocumentSnapshot(bytes: bytes, version: version, position: nil)) != nil
        else { throw Failure.content }
        guard let context = ContextChip(source: .file, app: "Text file", text: text),
              !context.truncated, Data(context.text.utf8) == bytes else { throw Failure.empty }
        let wire: [String: Any] = ["text": text, "explanation": "", "version": version,
                                  "taskId": String(repeating: "0", count: 36), "revision": 9_007_199_254_740_991]
        guard let encoded = try? JSONSerialization.data(withJSONObject: wire, options: [.withoutEscapingSlashes]),
              encoded.count <= 8160 else { throw Failure.wire }
        let document = DocumentHandle(app: "Text file", locator: .file(rootID: located.rootID, relative: located.relative),
                                      version: version, label: url.lastPathComponent)
        guard document.valid else { throw Failure.content }
        return Self(context: context, document: document)
    }
}
