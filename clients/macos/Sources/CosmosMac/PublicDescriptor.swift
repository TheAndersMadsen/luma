import CryptoKit
import Foundation

/// Public enrollment material only; connection credentials never enter this value.
public struct PublicDescriptor: Equatable, Sendable {
    public let enrollmentID: UUID
    public let publicKey: String
    public let fingerprint: String
    public let platform = "macos"
    public let approval = "native-shared-display-v2"

    public init(enrollmentID: UUID, publicKeyBytes: Data) throws {
        guard enrollmentID != UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)),
              publicKeyBytes.count == 65, publicKeyBytes.first == 4,
              let key = try? P256.Signing.PublicKey(x963Representation: publicKeyBytes),
              key.x963Representation == publicKeyBytes else {
            throw ClientFailure.identityUnavailable
        }
        self.enrollmentID = enrollmentID
        publicKey = Self.base64URL(publicKeyBytes)
        fingerprint = SHA256.hash(data: publicKeyBytes).map { String(format: "%02x", $0) }.joined()
    }

    public init(enrollmentID: UUID, publicKey: String) throws {
        guard publicKey.utf8.count == 87,
              publicKey.utf8.allSatisfy({ byte in
                  (65...90).contains(byte) || (97...122).contains(byte)
                      || (48...57).contains(byte) || byte == 45 || byte == 95
              }),
              let bytes = Data(base64Encoded: publicKey
                  .replacingOccurrences(of: "-", with: "+")
                  .replacingOccurrences(of: "_", with: "/") + "="),
              Self.base64URL(bytes) == publicKey else {
            throw ClientFailure.identityUnavailable
        }
        try self.init(enrollmentID: enrollmentID, publicKeyBytes: bytes)
    }

    public func encoded() throws -> Data {
        struct Export: Encodable {
            let enrollmentId: String
            let publicKey: String
            let platform: String
            let approval: String
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let data = try encoder.encode(Export(
            enrollmentId: enrollmentID.uuidString.lowercased(), publicKey: publicKey,
            platform: platform, approval: approval
        ))
        guard data.count <= 1024 else { throw ClientFailure.identityUnavailable }
        return data
    }

    private static func base64URL(_ bytes: Data) -> String {
        bytes.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
