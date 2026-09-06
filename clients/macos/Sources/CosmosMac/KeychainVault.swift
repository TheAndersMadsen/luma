import CryptoKit
import Foundation
import Security

/// One installation identity, independent of the selected Cosmos server.
/// Uses the selected user file Keychain, with app-specific access and no prompts.
/// Journal data is encrypted by Keychain; private key bytes never leave Security
/// through this application's code. This is not a Secure Enclave identity.
public final class KeychainVault: @unchecked Sendable {
    public static let maximumJournalBytes = 65_536

    private static let keyTag = Data("dk.andersmadsen.cosmos.desktop.installation.v1".utf8)
    private static let journalService = "dk.andersmadsen.cosmos.desktop.journal.v1"
    private static let process = ProcessState()

    private final class ProcessState: @unchecked Sendable {
        let factoryLock = NSLock()
        let securityLock = NSLock()
        var interactionFailed = false
        var vault: KeychainVault?
    }

    private struct Storage {
        let keychain: SecKeychain
        let application: SecTrustedApplication
        let applicationPath: Data
        /// The Keychain partition of signed code: `teamid:` plus the team identifier.
        /// Ad-hoc or unsigned builds have none and are trusted by path only.
        let partition: String?
    }

    private struct Identity {
        let key: SecKey
        let descriptor: PublicDescriptor
    }

    private enum JournalChange {
        case write(account: String, bytes: Data)
        case delete(account: String)

        var account: String {
            switch self {
            case .write(let account, _), .delete(let account): account
            }
        }
    }

    private struct Journal {
        let item: SecKeychainItem
        let bytes: Data
    }

    private let lock = NSLock()
    private let storage: Storage
    private let publicDescriptor: PublicDescriptor
    private var pending: JournalChange?

    private init(storage: Storage, descriptor: PublicDescriptor) {
        self.storage = storage
        publicDescriptor = descriptor
    }

    /// Called only by an explicit application action, never by module initialization.
    public static func loadOrCreate() throws -> KeychainVault {
        process.factoryLock.lock()
        defer { process.factoryLock.unlock() }
        // A second factory call must not discard an earlier failed journal write.
        if let vault = process.vault { return vault }
        let vault = try withoutInteraction {
            var selected: SecKeychain?
            guard SecKeychainCopyDomainDefault(.user, &selected) == errSecSuccess,
                  let keychain = selected else { throw ClientFailure.storageUnavailable }
            try unlocked(keychain)
            var application: SecTrustedApplication?
            guard SecTrustedApplicationCreateFromPath(nil, &application) == errSecSuccess,
                  let application else { throw ClientFailure.storageUnavailable }
            let storage = Storage(keychain: keychain, application: application,
                                  applicationPath: try trustedPath(application),
                                  partition: signingPartition())
            let identity: Identity
            if let stored = try readIdentity(storage) {
                identity = stored
            } else {
                // A deleted identity with surviving sessions is not a new installation.
                var query = journalQuery(storage)
                query[kSecReturnAttributes as String] = true
                query[kSecMatchLimit as String] = kSecMatchLimitAll
                guard try records(query).isEmpty else { throw ClientFailure.identityUnavailable }
                identity = try createIdentity(storage)
            }
            return KeychainVault(storage: storage, descriptor: identity.descriptor)
        }
        process.vault = vault
        return vault
    }

    public func descriptor() -> PublicDescriptor { publicDescriptor }

    public var pendingStorageWrite: Bool {
        lock.lock()
        defer { lock.unlock() }
        return pending != nil
    }

    /// The bridge calls this before opening or continuing a connection.
    public func requireReady() throws {
        lock.lock()
        defer { lock.unlock() }
        try requireNoPendingChange()
        try Self.withoutInteraction { _ = try currentIdentity() }
    }

    /// The Rust client supplies the complete domain-separated transcript. This
    /// message algorithm performs SHA-256 internally, exactly once.
    public func sign(message: Data) throws -> Data {
        lock.lock()
        defer { lock.unlock() }
        try requireNoPendingChange()
        return try Self.withoutInteraction {
            let identity = try currentIdentity()
            guard message.count <= 2048,
                  message.starts(with: Data("cosmos.native.open.v1\0".utf8)),
                  SecKeyIsAlgorithmSupported(identity.key, .sign, .ecdsaSignatureMessageX962SHA256) else {
                throw ClientFailure.identityUnavailable
            }
            var error: Unmanaged<CFError>?
            guard let signature = SecKeyCreateSignature(
                identity.key, .ecdsaSignatureMessageX962SHA256, message as CFData, &error
            ) as Data? else {
                _ = error?.takeRetainedValue()
                throw ClientFailure.identityUnavailable
            }
            guard signature.count <= 72,
                  let parsed = try? P256.Signing.ECDSASignature(derRepresentation: signature),
                  parsed.derRepresentation == signature,
                  let publicKey = SecKeyCopyPublicKey(identity.key),
                  let bytes = try? Self.publicBytes(publicKey),
                  let verifier = try? P256.Signing.PublicKey(x963Representation: bytes),
                  verifier.isValidSignature(parsed, for: message) else {
                throw ClientFailure.identityUnavailable
            }
            return signature
        }
    }

    public func readJournal(server: ServerEndpoint) throws -> Data? {
        lock.lock()
        defer { lock.unlock() }
        try requireNoPendingChange()
        return try Self.withoutInteraction {
            _ = try currentIdentity()
            return try journal(account: journalAccount(server))?.bytes
        }
    }

    public func writeJournal(_ bytes: Data, server: ServerEndpoint) throws {
        lock.lock()
        defer { lock.unlock() }
        try requireNoPendingChange()
        guard bytes.count <= Self.maximumJournalBytes else { throw ClientFailure.storageUnavailable }
        let retained = bytes.withUnsafeBytes { (source: UnsafeRawBufferPointer) in Data(source) }
        pending = .write(account: journalAccount(server), bytes: retained)
        try commitPendingChange()
    }

    public func clearJournal(server: ServerEndpoint) throws {
        lock.lock()
        defer { lock.unlock() }
        try requireNoPendingChange()
        pending = .delete(account: journalAccount(server))
        try commitPendingChange()
    }

    public func retryPendingJournalWrite() throws {
        lock.lock()
        defer { lock.unlock() }
        try commitPendingChange()
    }

    private func requireNoPendingChange() throws {
        guard pending == nil else { throw ClientFailure.storageBlocked }
    }

    private func currentIdentity() throws -> Identity {
        try Self.unlocked(storage.keychain)
        guard let identity = try Self.readIdentity(storage), identity.descriptor == publicDescriptor else {
            throw ClientFailure.identityUnavailable
        }
        return identity
    }

    private func journalAccount(_ server: ServerEndpoint) -> String {
        let originDigest = SHA256.hash(data: Data(server.origin.utf8))
            .map { String(format: "%02x", $0) }.joined()
        return publicDescriptor.enrollmentID.uuidString.lowercased() + ":" + originDigest
    }

    private var journalLabel: String {
        "Cosmos journal v1|" + publicDescriptor.enrollmentID.uuidString.lowercased()
            + "|" + publicDescriptor.fingerprint
    }

    private func journal(account: String) throws -> Journal? {
        var query = Self.journalQuery(storage, account: account)
        query[kSecReturnAttributes as String] = true
        query[kSecReturnRef as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        let matches = try Self.records(query)
        guard !matches.isEmpty else { return nil }
        guard matches.count == 1 else { throw ClientFailure.storageUnavailable }
        let item = matches[0]
        guard item[kSecAttrService as String] as? String == Self.journalService,
              item[kSecAttrAccount as String] as? String == account,
              item[kSecAttrLabel as String] as? String == journalLabel,
              let reference = item[kSecValueRef as String],
              CFGetTypeID(reference as CFTypeRef) == SecKeychainItemGetTypeID() else {
            throw ClientFailure.storageUnavailable
        }
        let referenceItem = reference as! SecKeychainItem
        try Self.verifyAccess(referenceItem, storage: storage, authorization: kSecACLAuthorizationDecrypt)
        var length: UInt32 = 0
        var data: UnsafeMutableRawPointer?
        let status = SecKeychainItemCopyAttributesAndData(referenceItem, nil, nil, nil, &length, &data)
        defer {
            if let data { SecKeychainItemFreeAttributesAndData(nil, data) }
        }
        guard status == errSecSuccess, length <= Self.maximumJournalBytes else {
            throw ClientFailure.storageUnavailable
        }
        let bytes: Data
        if length == 0 {
            bytes = Data()
        } else {
            guard let data else { throw ClientFailure.storageUnavailable }
            bytes = Data(bytes: data, count: Int(length))
        }
        return Journal(item: referenceItem, bytes: bytes)
    }

    /// The pending bytes/account remain unchanged across every failed attempt,
    /// including a successful mutation followed by uncertain readback.
    private func commitPendingChange() throws {
        guard let change = pending else { return }
        do {
            try Self.withoutInteraction {
                _ = try currentIdentity()
                let existing = try journal(account: change.account)
                switch change {
                case .write(_, let bytes):
                    let status: OSStatus
                    if let existing {
                        // Update only the validated item, without changing metadata or
                        // ACL. SecItemUpdate has a legacy item-replacement path.
                        status = Self.withJournalBytes(bytes) { pointer, length in
                            SecKeychainItemModifyAttributesAndData(existing.item, nil, length, pointer)
                        }
                    } else {
                        let item: [String: Any] = [
                            kSecClass as String: kSecClassGenericPassword,
                            kSecAttrService as String: Self.journalService,
                            kSecAttrAccount as String: change.account,
                            kSecValueData as String: bytes,
                            kSecAttrLabel as String: journalLabel,
                            kSecUseKeychain as String: storage.keychain,
                            kSecAttrAccess as String: try Self.applicationAccess(storage),
                        ]
                        status = SecItemAdd(item as CFDictionary, nil)
                    }
                    guard status == errSecSuccess, try journal(account: change.account)?.bytes == bytes else {
                        throw ClientFailure.storageUnavailable
                    }
                case .delete:
                    if let existing {
                        guard SecKeychainItemDelete(existing.item) == errSecSuccess else {
                            throw ClientFailure.storageUnavailable
                        }
                    }
                    guard try journal(account: change.account) == nil else {
                        throw ClientFailure.storageUnavailable
                    }
                }
            }
            // Restoration of the process interaction setting must also succeed.
            pending = nil
        } catch {
            throw ClientFailure.storageBlocked
        }
    }

    private static func identityLabel(_ descriptor: PublicDescriptor) -> String {
        "Cosmos installation v1|" + descriptor.enrollmentID.uuidString.lowercased()
            + "|" + descriptor.publicKey
    }

    private static func identityQuery(_ storage: Storage) -> [String: Any] {
        [kSecClass as String: kSecClassKey,
         kSecAttrApplicationTag as String: keyTag,
         kSecMatchSearchList as String: [storage.keychain]]
    }

    private static func journalQuery(_ storage: Storage, account: String? = nil) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: journalService,
            kSecMatchSearchList as String: [storage.keychain],
        ]
        if let account { query[kSecAttrAccount as String] = account }
        return query
    }

    /// File-Keychain interaction is process-wide, so all Security work here
    /// shares this lock. No asynchronous operation can escape this scope.
    private static func withoutInteraction<T>(_ operation: () throws -> T) throws -> T {
        process.securityLock.lock()
        defer { process.securityLock.unlock() }
        guard !process.interactionFailed else { throw ClientFailure.storageUnavailable }
        var previous = DarwinBoolean(false)
        guard SecKeychainGetUserInteractionAllowed(&previous) == errSecSuccess else {
            throw ClientFailure.storageUnavailable
        }
        let disabled = SecKeychainSetUserInteractionAllowed(false)
        let result: Result<T, Error>
        if disabled == errSecSuccess {
            result = Result { try operation() }
        } else {
            result = .failure(ClientFailure.storageUnavailable)
        }
        guard SecKeychainSetUserInteractionAllowed(previous.boolValue) == errSecSuccess else {
            process.interactionFailed = true
            throw ClientFailure.storageUnavailable
        }
        return try result.get()
    }

    private static func unlocked(_ keychain: SecKeychain) throws {
        var status: SecKeychainStatus = 0
        let required = kSecUnlockStateStatus | kSecReadPermStatus | kSecWritePermStatus
        guard SecKeychainGetStatus(keychain, &status) == errSecSuccess,
              status & required == required else { throw ClientFailure.storageUnavailable }
    }

    private static func applicationAccess(_ storage: Storage) throws -> SecAccess {
        var access: SecAccess?
        guard SecAccessCreate("Cosmos desktop" as CFString,
                              [storage.application] as CFArray, &access) == errSecSuccess,
              let access else { throw ClientFailure.storageUnavailable }
        try verifyAccess(access, storage: storage, authorization: kSecACLAuthorizationSign)
        try verifyAccess(access, storage: storage, authorization: kSecACLAuthorizationDecrypt)
        return access
    }

    private static func verifyAccess(_ item: SecKeychainItem, storage: Storage,
                                     authorization: CFString) throws {
        var access: SecAccess?
        guard SecKeychainItemCopyAccess(item, &access) == errSecSuccess,
              let access else { throw ClientFailure.storageUnavailable }
        try verifyAccess(access, storage: storage, authorization: authorization)
    }

    private static func verifyAccess(_ access: SecAccess, storage: Storage,
                                     authorization: CFString) throws {
        guard let grants = SecAccessCopyMatchingACLList(access, authorization) as? [Any],
              !grants.isEmpty, grants.count <= 16 else { throw ClientFailure.storageUnavailable }
        for grant in grants {
            guard CFGetTypeID(grant as CFTypeRef) == SecACLGetTypeID() else {
                throw ClientFailure.storageUnavailable
            }
            var applications: CFArray?
            var description: CFString?
            var prompt = SecKeychainPromptSelector(rawValue: 0)
            guard SecACLCopyContents(grant as! SecACL, &applications, &description, &prompt) == errSecSuccess else {
                throw ClientFailure.storageUnavailable
            }
            if let applications = applications as? [Any] {
                guard applications.count == 1,
                      CFGetTypeID(applications[0] as CFTypeRef) == SecTrustedApplicationGetTypeID(),
                      try trustedPath(applications[0] as! SecTrustedApplication) == storage.applicationPath else {
                    throw ClientFailure.storageUnavailable
                }
            } else {
                // Items created by signed code carry no application list: macOS
                // stores their access as a partition list instead, and "no list"
                // would otherwise mean any application. Require exactly this
                // code's own team partition.
                try verifyPartition(access, storage: storage)
            }
        }
        // This is a bounded ACL/path check, not equality of code requirements.
        // The actual no-UI read/sign is the OS check that this caller is trusted.
        // Owner/integrity/partition ACLs do not grant these sensitive operations.
    }

    /// macOS keeps a signed app's partition list in the one ACL entry that
    /// carries the partition authorization; its description is the
    /// hex-encoded property list `{Partitions: [...]}`.
    private static func verifyPartition(_ access: SecAccess, storage: Storage) throws {
        guard let partition = storage.partition,
              let grants = SecAccessCopyMatchingACLList(access, kSecACLAuthorizationPartitionID) as? [Any],
              !grants.isEmpty, grants.count <= 16 else {
            throw ClientFailure.storageUnavailable
        }
        var lists: [[String]] = []
        for grant in grants {
            guard CFGetTypeID(grant as CFTypeRef) == SecACLGetTypeID() else {
                throw ClientFailure.storageUnavailable
            }
            let authorizations = (SecACLCopyAuthorizations(grant as! SecACL) as? [String]) ?? []
            guard authorizations.contains(kSecACLAuthorizationPartitionID as String) else { continue }
            var applications: CFArray?
            var description: CFString?
            var prompt = SecKeychainPromptSelector(rawValue: 0)
            guard SecACLCopyContents(grant as! SecACL, &applications, &description, &prompt) == errSecSuccess,
                  let encoded = description as String?, encoded.utf8.count <= 8192, encoded.utf8.count % 2 == 0,
                  let bytes = decodeHex(encoded),
                  let plist = try? PropertyListSerialization.propertyList(from: bytes, format: nil),
                  let partitions = (plist as? [String: Any])?["Partitions"] as? [String] else {
                throw ClientFailure.storageUnavailable
            }
            lists.append(partitions)
        }
        guard lists == [[partition]] else { throw ClientFailure.storageUnavailable }
    }

    private static func decodeHex(_ text: String) -> Data? {
        var bytes = Data(capacity: text.utf8.count / 2)
        var high: UInt8?
        for character in text.utf8 {
            let nibble: UInt8
            switch character {
            case 48...57: nibble = character - 48
            case 97...102: nibble = character - 87
            case 65...70: nibble = character - 55
            default: return nil
            }
            if let previous = high {
                bytes.append(previous << 4 | nibble)
                high = nil
            } else {
                high = nibble
            }
        }
        return high == nil ? bytes : nil
    }

    /// The running code's team partition, or nil for ad-hoc and unsigned code.
    private static func signingPartition() -> String? {
        var code: SecCode?
        guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess, let code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess,
              let staticCode else { return nil }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation),
                                            &information) == errSecSuccess,
              let team = (information as? [String: Any])?[kSecCodeInfoTeamIdentifier as String] as? String,
              !team.isEmpty, team.utf8.count <= 32,
              team.utf8.allSatisfy({ (65...90).contains($0) || (48...57).contains($0) }) else { return nil }
        return "teamid:" + team
    }

    private static func trustedPath(_ application: SecTrustedApplication) throws -> Data {
        var data: CFData?
        guard SecTrustedApplicationCopyData(application, &data) == errSecSuccess,
              let path = data as Data?, path.count > 1, path.count <= 4096,
              path.last == 0, !path.dropLast().contains(0) else {
            throw ClientFailure.storageUnavailable
        }
        return path
    }

    /// A null data pointer means "do not modify" to the legacy API, including
    /// when length is zero. Empty journals must pass a nonnull sentinel.
    static func withJournalBytes<T>(_ bytes: Data, _ body: (UnsafeRawPointer, UInt32) -> T) -> T {
        precondition(bytes.count <= maximumJournalBytes)
        if bytes.isEmpty {
            var sentinel: UInt8 = 0
            return withUnsafePointer(to: &sentinel) { body(UnsafeRawPointer($0), 0) }
        }
        return bytes.withUnsafeBytes { body($0.baseAddress!, UInt32(bytes.count)) }
    }

    /// Security may return numeric key attributes as CFNumber or CFString.
    /// Bool, fractions and sign-prefixed or noncanonical strings are rejected.
    static func keyAttribute(_ value: Any?, matches expected: CFString) -> Bool {
        guard let expectedNumber = UInt64(expected as String) else { return false }
        let text: String
        if let number = value as? NSNumber {
            let encoding = String(cString: number.objCType)
            guard CFGetTypeID(number) != CFBooleanGetTypeID(),
                  encoding.count == 1, "cCsSiIlLqQ".contains(encoding) else { return false }
            text = number.stringValue
        } else if let string = value as? String {
            text = string
        } else {
            return false
        }
        guard let number = UInt64(text), String(number) == text else { return false }
        return number == expectedNumber
    }

    private static func records(_ query: [String: Any]) throws -> [[String: Any]] {
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let items = result as? [[String: Any]] else {
            throw ClientFailure.storageUnavailable
        }
        return items
    }

    private static func readIdentity(_ storage: Storage) throws -> Identity? {
        var query = identityQuery(storage)
        query[kSecReturnAttributes as String] = true
        query[kSecReturnRef as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitAll
        let matches = try records(query)
        guard !matches.isEmpty else { return nil }
        guard matches.count == 1 else { throw ClientFailure.identityUnavailable }
        let item = matches[0]
        guard item[kSecAttrApplicationTag as String] as? Data == keyTag,
              keyAttribute(item[kSecAttrKeyType as String], matches: kSecAttrKeyTypeECSECPrimeRandom),
              keyAttribute(item[kSecAttrKeyClass as String], matches: kSecAttrKeyClassPrivate),
              keyAttribute(item[kSecAttrKeySizeInBits as String], matches: "256" as CFString),
              let label = item[kSecAttrLabel as String] as? String, label.utf8.count <= 256,
              let reference = item[kSecValueRef as String],
              CFGetTypeID(reference as CFTypeRef) == SecKeyGetTypeID() else {
            throw ClientFailure.identityUnavailable
        }
        let key = reference as! SecKey
        guard let attributes = SecKeyCopyAttributes(key) as? [String: Any],
              keyAttribute(attributes[kSecAttrKeyType as String], matches: kSecAttrKeyTypeECSECPrimeRandom),
              keyAttribute(attributes[kSecAttrKeyClass as String], matches: kSecAttrKeyClassPrivate),
              keyAttribute(attributes[kSecAttrKeySizeInBits as String], matches: "256" as CFString),
              SecKeyIsAlgorithmSupported(key, .sign, .ecdsaSignatureMessageX962SHA256),
              let publicKey = SecKeyCopyPublicKey(key) else {
            throw ClientFailure.identityUnavailable
        }
        // Explicit file-Keychain queries return legacy key refs; Apple's public
        // item-access API accepts that same legacy object as SecKeychainItem.
        // An identity created by another application (a rebuilt ad-hoc signed
        // app at a new path) is this installation's identity, not a storage
        // fault: report it as unusable rather than as a locked Keychain.
        do {
            try verifyAccess(unsafeBitCast(key, to: SecKeychainItem.self), storage: storage,
                             authorization: kSecACLAuthorizationSign)
        } catch {
            throw ClientFailure.identityUnavailable
        }
        let parts = label.components(separatedBy: "|")
        guard parts.count == 3, parts[0] == "Cosmos installation v1",
              let enrollmentID = UUID(uuidString: parts[1]) else {
            throw ClientFailure.identityUnavailable
        }
        let descriptor = try PublicDescriptor(enrollmentID: enrollmentID, publicKey: parts[2])
        let derived = try PublicDescriptor(enrollmentID: enrollmentID, publicKeyBytes: publicBytes(publicKey))
        guard descriptor == derived, label == identityLabel(descriptor) else {
            throw ClientFailure.identityUnavailable
        }
        return Identity(key: key, descriptor: descriptor)
    }

    private static func createIdentity(_ storage: Storage) throws -> Identity {
        var error: Unmanaged<CFError>?
        let access = try applicationAccess(storage)
        // These legacy selectors are required so the temporary key supports the
        // file-Keychain add-by-reference path. Do not mark it nonextractable:
        // Security's internal import wraps it. Application code exports only
        // its public point, never private bytes.
        guard let key = SecKeyCreateRandomKey([
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrIsPermanent as String: false,
            kSecUseKeychain as String: storage.keychain,
            kSecAttrAccess as String: access,
        ] as CFDictionary, &error) else {
            _ = error?.takeRetainedValue()
            throw ClientFailure.identityUnavailable
        }
        guard let publicKey = SecKeyCopyPublicKey(key) else { throw ClientFailure.identityUnavailable }
        let descriptor = try PublicDescriptor(enrollmentID: UUID(), publicKeyBytes: publicBytes(publicKey))
        let item: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: keyTag,
            kSecValueRef as String: key,
            kSecAttrLabel as String: identityLabel(descriptor),
            kSecUseKeychain as String: storage.keychain,
            kSecAttrAccess as String: access,
        ]
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess,
              let persisted = try readIdentity(storage), persisted.descriptor == descriptor else {
            // Never delete an uncertain item or replace a competing identity.
            throw ClientFailure.identityUnavailable
        }
        return persisted
    }

    private static func publicBytes(_ publicKey: SecKey) throws -> Data {
        guard let attributes = SecKeyCopyAttributes(publicKey) as? [String: Any],
              keyAttribute(attributes[kSecAttrKeyClass as String], matches: kSecAttrKeyClassPublic) else {
            throw ClientFailure.identityUnavailable
        }
        var error: Unmanaged<CFError>?
        guard let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            _ = error?.takeRetainedValue()
            throw ClientFailure.identityUnavailable
        }
        return data
    }
}
