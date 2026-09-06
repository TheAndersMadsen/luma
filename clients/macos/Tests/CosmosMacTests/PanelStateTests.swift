import AppKit
import SwiftUI
import XCTest
@testable import CosmosMac

final class PanelStateTests: XCTestCase {
    func testFingerprintGroupsIntoFourCharacterBlocksAndTwoLines() {
        let fingerprint = "698bea63dc44a344663ff1429aea10842df27b6b991ef25866b2c6c02cdcc5be"
        let grouped = PanelState.groupedFingerprint(fingerprint)
        XCTAssertEqual(grouped, """
        698b ea63 dc44 a344 663f f142 9aea 1084
        2df2 7b6b 991e f258 66b2 c6c0 2cdc c5be
        """)
        XCTAssertEqual(grouped.filter(\.isHexDigit), fingerprint, "grouping never changes a digit")
        XCTAssertEqual(PanelState.groupedFingerprint("abcdef"), "abcd ef")
        XCTAssertEqual(PanelState.groupedFingerprint("abcdef", blockLength: 2, blocksPerLine: 2), "ab cd\nef")
        XCTAssertEqual(PanelState.groupedFingerprint(""), "")
        XCTAssertEqual(PanelState.groupedFingerprint("not a fingerprint"), "not a fingerprint")
        XCTAssertEqual(PanelState.groupedFingerprint("abcd", blockLength: 0), "abcd")
    }

    func testServerSummaryShowsTheHostOnly() {
        XCTAssertEqual(PanelState.serverSummary("https://center.andersmadsen.dk"), "center.andersmadsen.dk")
        XCTAssertEqual(PanelState.serverSummary(" https://center.example:8443/ \n"), "center.example:8443")
        XCTAssertEqual(PanelState.serverSummary("center.example"), "center.example")
        XCTAssertEqual(PanelState.serverSummary(""), "")
    }

    func testStageFollowsIdentityAndConnection() {
        XCTAssertEqual(PanelState.stage(hasDescriptor: false, phase: .disconnected, rejoining: false), .setup)
        XCTAssertEqual(PanelState.stage(hasDescriptor: false, phase: .preparing, rejoining: false), .setup)
        XCTAssertEqual(PanelState.stage(hasDescriptor: false, phase: .blocked, rejoining: false), .setup)
        XCTAssertEqual(PanelState.stage(hasDescriptor: true, phase: .prepared, rejoining: false), .approve)
        XCTAssertEqual(PanelState.stage(hasDescriptor: true, phase: .connecting, rejoining: false), .approve)
        XCTAssertEqual(PanelState.stage(hasDescriptor: true, phase: .disconnected, rejoining: false), .approve)
        XCTAssertEqual(PanelState.stage(hasDescriptor: true, phase: .blocked, rejoining: false), .approve)
        XCTAssertEqual(PanelState.stage(hasDescriptor: true, phase: .connected, rejoining: false), .connected)
        XCTAssertEqual(PanelState.stage(hasDescriptor: true, phase: .disconnecting, rejoining: false), .connected)
        XCTAssertEqual(PanelState.stage(hasDescriptor: true, phase: .prepared, rejoining: true), .connected,
                       "a retained connection being rejoined keeps the assistant layout")
        XCTAssertEqual(PanelState.stage(hasDescriptor: true, phase: .connecting, rejoining: true), .connected)
    }

    func testStatusPillUsesShortStates() {
        XCTAssertEqual(PanelState.status(phase: .connected, rejoining: false), .connected)
        XCTAssertEqual(PanelState.status(phase: .connecting, rejoining: false), .connecting)
        XCTAssertEqual(PanelState.status(phase: .connecting, rejoining: true), .reconnecting)
        XCTAssertEqual(PanelState.status(phase: .disconnected, rejoining: true), .reconnecting)
        XCTAssertEqual(PanelState.status(phase: .prepared, rejoining: true), .reconnecting)
        XCTAssertEqual(PanelState.status(phase: .disconnecting, rejoining: false), .disconnecting)
        for phase in [ClientPhase.disconnected, .preparing, .prepared, .blocked] {
            XCTAssertEqual(PanelState.status(phase: phase, rejoining: false), .disconnected)
        }
        XCTAssertEqual(ConnectionStatus.connected.label, "Connected")
        XCTAssertEqual(ConnectionStatus.reconnecting.label, "Reconnecting…")
        XCTAssertEqual(ConnectionStatus.disconnected.label, "Disconnected")
    }

    func testWaveformPhaseRanksPlaybackOverWorkOverFailure() {
        XCTAssertEqual(PanelState.waveform(speaking: false, busy: false, rejoining: false, failed: false), .idle)
        XCTAssertEqual(PanelState.waveform(speaking: false, busy: true, rejoining: false, failed: false), .thinking)
        XCTAssertEqual(PanelState.waveform(speaking: false, busy: false, rejoining: true, failed: false), .thinking)
        XCTAssertEqual(PanelState.waveform(speaking: false, busy: false, rejoining: false, failed: true), .error)
        XCTAssertEqual(PanelState.waveform(speaking: false, busy: true, rejoining: false, failed: true), .thinking,
                       "a retry in progress shows work, not the stale failure")
        XCTAssertEqual(PanelState.waveform(speaking: true, busy: true, rejoining: true, failed: true), .speaking,
                       "observed playback is the most immediate truth")
        XCTAssertEqual(CosmosPhase.idle.label, "Ready")
        XCTAssertEqual(CosmosPhase.error.label, "Needs attention")
        XCTAssertFalse(CosmosPhase.idle.animated)
        XCTAssertFalse(CosmosPhase.error.animated)
        XCTAssertTrue(CosmosPhase.thinking.animated)
        XCTAssertTrue(CosmosPhase.speaking.animated)
    }

    func testNoticesSkipCopyThatRestatesTheStage() {
        XCTAssertTrue(PanelState.restatesStage(ClientModel.initialMessage, stage: .setup))
        XCTAssertFalse(PanelState.restatesStage(ClientModel.initialMessage, stage: .approve))
        XCTAssertTrue(PanelState.restatesStage(ClientModel.approveMessage, stage: .approve))
        XCTAssertTrue(PanelState.restatesStage(ClientModel.connectedMessage, stage: .connected))
        XCTAssertFalse(PanelState.restatesStage("Request admitted by Cosmos. The response appears on the approved display it selects.", stage: .connected))
        XCTAssertTrue(PanelState.isFailureMessage(ClientFailure.approvalRequired.message))
        XCTAssertTrue(PanelState.isFailureMessage(ClientFailure.identityUnavailable.message))
        XCTAssertFalse(PanelState.isFailureMessage(ClientModel.connectedMessage))
        XCTAssertFalse(PanelState.isFailureMessage(""))
    }

    /// The nebula sits along the bottom edge and only while the texture is allowed.
    @MainActor
    func testPanelBackgroundDrawsTheNebulaOnlyWhenAllowed() throws {
        func bottomTint(showTexture: Bool) throws -> (red: CGFloat, green: CGFloat, blue: CGFloat) {
            let renderer = ImageRenderer(content: PanelBackground(showTexture: showTexture)
                .frame(width: CosmosTokens.panelWidth, height: 400))
            renderer.scale = 1
            let image = try XCTUnwrap(renderer.cgImage)
            let bitmap = NSBitmapImageRep(cgImage: image)
            let pixel = try XCTUnwrap(bitmap.colorAt(x: image.width / 2, y: image.height - 60))
            let color = try XCTUnwrap(pixel.usingColorSpace(.sRGB))
            return (color.redComponent, color.greenComponent, color.blueComponent)
        }
        let plain = try bottomTint(showTexture: false)
        XCTAssertLessThan(plain.blue, 0.15, "without the texture the bottom is the flat kit background")
        let textured = try bottomTint(showTexture: true)
        XCTAssertGreaterThan(textured.blue, plain.blue + 0.2, "the nebula glows cyan along the bottom")
        XCTAssertGreaterThan(textured.green, plain.green + 0.2)
        XCTAssertLessThan(textured.red, textured.blue, "the glow is the kit's cyan, not a wash-out")
    }

    @MainActor
    func testKitResourcesLoadFromTheResourceBundle() throws {
        let nebula = try XCTUnwrap(CosmosResources.nebula)
        XCTAssertGreaterThan(nebula.size.width, nebula.size.height, "the nebula is a wide bottom texture")
        let icon = CosmosResources.menuBarIcon
        XCTAssertTrue(icon.isTemplate, "the menu-bar glyph is monochrome and system-tinted")
        XCTAssertEqual(icon.size, NSSize(width: 20, height: 16))
        XCTAssertEqual(icon.representations.count, 2, "1x and 2x representations from the kit")
    }
}
