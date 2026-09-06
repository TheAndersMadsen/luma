import Foundation
import Security
import XCTest
@testable import CosmosMac

final class PublicDescriptorTests: XCTestCase {
    // SEC 2 P-256 generator point; public interoperability vector, never an identity.
    private let publicKey = "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU"
    private let fingerprint = "698bea63dc44a344663ff1429aea10842df27b6b991ef25866b2c6c02cdcc5be"
    private let enrollmentID = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!

    func testPublicContractVectorAndExactExport() throws {
        let descriptor = try PublicDescriptor(enrollmentID: enrollmentID, publicKey: publicKey)
        XCTAssertEqual(descriptor.enrollmentID, enrollmentID)
        XCTAssertEqual(descriptor.publicKey, publicKey)
        XCTAssertEqual(descriptor.fingerprint, fingerprint)
        XCTAssertEqual(descriptor.platform, "macos")
        XCTAssertEqual(descriptor.approval, "native-shared-speech-v3")
        let encoded = try descriptor.encoded()
        XCTAssertLessThanOrEqual(encoded.count, 1024)
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: String])
        XCTAssertEqual(fields, [
            "enrollmentId": "11111111-1111-4111-8111-111111111111",
            "publicKey": publicKey, "platform": "macos", "approval": "native-shared-speech-v3",
        ])
        XCTAssertEqual(encoded, try descriptor.encoded())
    }

    func testRawPublicPointProducesSameCanonicalDescriptor() throws {
        let bytes = try publicBytes()
        XCTAssertEqual(bytes.count, 65)
        XCTAssertEqual(bytes.first, 4)
        XCTAssertEqual(
            try PublicDescriptor(enrollmentID: enrollmentID, publicKeyBytes: bytes),
            try PublicDescriptor(enrollmentID: enrollmentID, publicKey: publicKey)
        )
    }

    func testRejectsNilEnrollment() throws {
        let nilID = UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))
        XCTAssertThrowsError(try PublicDescriptor(enrollmentID: nilID, publicKey: publicKey))
        XCTAssertThrowsError(try PublicDescriptor(enrollmentID: nilID, publicKeyBytes: publicBytes()))
    }

    func testRejectsNoncanonicalBase64AndUnusedTrailingBits() {
        let invalid = [
            publicKey + "=", " " + publicKey, publicKey + "\n", publicKey.lowercased(),
            publicKey.replacingOccurrences(of: "-", with: "+"),
            publicKey.replacingOccurrences(of: "_", with: "/"),
            String(publicKey.dropLast()) + "V", String(publicKey.dropLast()),
            "é" + String(publicKey.dropFirst()), "",
        ]
        for candidate in invalid {
            XCTAssertThrowsError(try PublicDescriptor(enrollmentID: enrollmentID, publicKey: candidate))
        }
    }

    func testRejectsInvalidSEC1ShapesAndOffCurveCoordinates() throws {
        let bytes = try publicBytes()
        var compressed = Data([2])
        compressed.append(bytes.dropFirst().prefix(32))
        var hybrid = bytes
        hybrid[0] = 6
        var zeroPoint = Data(repeating: 0, count: 65)
        zeroPoint[0] = 4
        var extra = bytes
        extra.append(0)
        for candidate in [Data(), Data(bytes.dropLast()), compressed, hybrid, zeroPoint, extra] {
            XCTAssertThrowsError(try PublicDescriptor(enrollmentID: enrollmentID, publicKeyBytes: candidate))
        }
        let encodedZeroPoint = zeroPoint.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        XCTAssertThrowsError(try PublicDescriptor(enrollmentID: enrollmentID, publicKey: encodedZeroPoint))
    }

    func testNumericSecurityAttributesAcceptIntegersAndCanonicalStringsOnly() throws {
        for expected in [kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClassPrivate, kSecAttrKeyClassPublic] {
            let spelling = expected as String
            let number = try XCTUnwrap(UInt64(spelling))
            XCTAssertTrue(KeychainVault.keyAttribute(spelling, matches: expected))
            XCTAssertTrue(KeychainVault.keyAttribute(NSNumber(value: number), matches: expected))
            XCTAssertFalse(KeychainVault.keyAttribute(NSNumber(value: true), matches: expected))
            XCTAssertFalse(KeychainVault.keyAttribute(NSNumber(value: false), matches: expected))
            XCTAssertFalse(KeychainVault.keyAttribute(NSNumber(value: Double(number) + 0.5), matches: expected))
            for invalid in ["+" + spelling, " " + spelling, "0" + spelling, spelling + ".0", "-1"] {
                XCTAssertFalse(KeychainVault.keyAttribute(invalid, matches: expected))
            }
            XCTAssertFalse(KeychainVault.keyAttribute(nil, matches: expected))
        }
    }

    func testEmptyJournalStillSuppliesANonnullPointer() {
        KeychainVault.withJournalBytes(Data()) { pointer, length in
            XCTAssertEqual(length, 0)
            XCTAssertNotEqual(UInt(bitPattern: pointer), 0)
        }
    }

    func testJournalPointerPreservesEveryBoundedByte() {
        let bytes = Data((0..<KeychainVault.maximumJournalBytes).map { UInt8(truncatingIfNeeded: $0) })
        KeychainVault.withJournalBytes(bytes) { pointer, length in
            XCTAssertEqual(Int(length), bytes.count)
            XCTAssertEqual(Data(bytes: pointer, count: Int(length)), bytes)
        }
    }

    private func publicBytes() throws -> Data {
        try XCTUnwrap(Data(base64Encoded: publicKey
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/") + "="))
    }
}
