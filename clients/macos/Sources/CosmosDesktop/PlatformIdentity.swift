import Darwin
import Foundation

enum DesktopPlatformError: Error {
    case alreadyRunning
    case localStorageUnavailable
    case bootIdentifierUnavailable
}

/// Holds the installation's journal ownership for the whole application lifetime.
/// The lock survives endpoint changes and is released only after native shutdown.
final class InstallationLease: @unchecked Sendable {
    private let descriptor: Int32

    private init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    static func acquire() throws -> InstallationLease {
        let manager = FileManager.default
        let directory = try manager.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true
        ).appendingPathComponent("Cosmos", isDirectory: true)
        try manager.createDirectory(
            at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        var directoryInfo = stat()
        guard lstat(directory.path, &directoryInfo) == 0,
              directoryInfo.st_mode & S_IFMT == S_IFDIR,
              directoryInfo.st_uid == getuid(),
              directoryInfo.st_mode & 0o077 == 0 else {
            throw DesktopPlatformError.localStorageUnavailable
        }
        let lockURL = directory.appendingPathComponent("desktop.lock", isDirectory: false)
        let descriptor = open(lockURL.path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw DesktopPlatformError.localStorageUnavailable }
        var owned = false
        defer { if !owned { close(descriptor) } }
        var info = stat()
        guard fstat(descriptor, &info) == 0,
              info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_nlink == 1,
              info.st_mode & 0o077 == 0 else {
            throw DesktopPlatformError.localStorageUnavailable
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            if errno == EWOULDBLOCK { throw DesktopPlatformError.alreadyRunning }
            throw DesktopPlatformError.localStorageUnavailable
        }
        owned = true
        return InstallationLease(descriptor: descriptor)
    }

    deinit {
        flock(descriptor, LOCK_UN)
        close(descriptor)
    }
}

enum SystemBootEpoch {
    /// macOS supplies one UUID for the boot, independent of this process or user.
    /// It fences protocol state; it does not attest identity or physical privacy.
    static func current() throws -> UUID {
        var size = 0
        guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0,
              size > 1, size <= 128 else {
            throw DesktopPlatformError.bootIdentifierUnavailable
        }
        var bytes = [CChar](repeating: 0, count: size)
        guard sysctlbyname("kern.bootsessionuuid", &bytes, &size, nil, 0) == 0,
              size > 1, size <= bytes.count, bytes[size - 1] == 0,
              let epoch = UUID(uuidString: String(cString: bytes)),
              epoch != UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)) else {
            throw DesktopPlatformError.bootIdentifierUnavailable
        }
        return epoch
    }
}
