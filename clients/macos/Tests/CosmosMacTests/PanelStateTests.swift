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
        // A Mac with a signed connection to return to was approved long ago; it is
        // never sent back through approval, even while an operation is unsettled.
        XCTAssertEqual(PanelState.stage(hasDescriptor: true, phase: .prepared, rejoining: false, retained: true),
                       .connected)
        XCTAssertEqual(PanelState.stage(hasDescriptor: true, phase: .disconnected, rejoining: false, retained: true),
                       .connected)
        XCTAssertEqual(PanelState.stage(hasDescriptor: false, phase: .disconnected, rejoining: false, retained: true),
                       .setup, "no identity is still the first step")
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
        XCTAssertEqual(CosmosPhase.thinking.label, Words.working)
        XCTAssertEqual(CosmosPhase.error.label, "Needs attention")
        XCTAssertFalse(CosmosPhase.idle.animated)
        XCTAssertFalse(CosmosPhase.error.animated)
        XCTAssertTrue(CosmosPhase.thinking.animated)
        XCTAssertTrue(CosmosPhase.speaking.animated)
    }

    /// Presence is the menu-bar glyph and nothing else: three states, no colour.
    func testPresenceIsQuietUnlessCosmosIsWorkingOrWaitingHere() {
        XCTAssertEqual(PanelState.presence(phase: .idle, waitingHere: false), .quiet)
        XCTAssertEqual(PanelState.presence(phase: .error, waitingHere: false), .quiet,
                       "a failure is explained in the panel, not shouted from the menu bar")
        XCTAssertEqual(PanelState.presence(phase: .thinking, waitingHere: false), .working)
        XCTAssertEqual(PanelState.presence(phase: .speaking, waitingHere: false), .working)
        XCTAssertEqual(PanelState.presence(phase: .idle, waitingHere: true), .waiting)
        XCTAssertEqual(PanelState.presence(phase: .thinking, waitingHere: true), .waiting,
                       "something the owner has to answer outranks work in progress")
        XCTAssertEqual(MenuPresence.waiting.help, "Cosmos · Waiting for you")
        XCTAssertEqual(MenuPresence.quiet.help, "Cosmos")
    }

    @MainActor
    func testExamplePromptsOnlySuggestWhatThisMacCanDo() {
        XCTAssertEqual(PanelState.examplePrompts(canReadSelection: false),
                       ["Find cafés near me", "Show my notes"])
        XCTAssertEqual(PanelState.examplePrompts(canReadSelection: true).count, 3)
        XCTAssertEqual(PanelState.examplePrompts(canReadSelection: true).last, "Summarise my selection")
        for prompt in PanelState.examplePrompts(canReadSelection: true) {
            XCTAssertTrue(ClientModel.validText(prompt), "an example must be sendable as it stands")
            // They are chips in one row under the field, so each one is short
            // enough to read at a glance and is the whole request it sends.
            XCTAssertLessThanOrEqual(prompt.count, 24, prompt)
        }
    }

    /// One notice at a time, and only about what the owner is doing now. The
    /// room state they can act on outranks the message the last operation left,
    /// and older news never stacks on top of either.
    func testThePanelShowsOneNoticeOrNoneAtAll() {
        XCTAssertNil(PanelState.notice(failure: nil), "a quiet panel says nothing at all")
        XCTAssertNil(PanelState.notice(failure: nil, message: ClientModel.connectedMessage),
                     "copy that only restates the stage is not a notice")

        // A failure the owner can act on wins over everything else, and it is
        // said once even when the message repeats it.
        let blocked = PanelState.notice(failure: .storageBlocked, hasPending: true, retained: true,
                                        message: ClientFailure.storageBlocked.message)
        XCTAssertEqual(blocked, ClientFailure.storageBlocked.notice)

        // A retained connection is a notice only while nothing is rejoining it.
        XCTAssertNotNil(PanelState.notice(failure: nil, retained: true))
        XCTAssertNil(PanelState.notice(failure: nil, retained: true, rejoining: true))

        // An unsettled request outranks the message, and the message is the
        // last thing left to say.
        XCTAssertEqual(PanelState.notice(failure: nil, hasPending: true, message: "Anything"),
                       ClientFailure.uncertainRequest.notice)
        XCTAssertEqual(PanelState.notice(failure: nil, message: "Cosmos has your request.")?.happened,
                       "Cosmos has your request.")
    }

    /// A client older than the runtime is not a red block over the ask field.
    /// Nothing about it can be acted on from here, so it is one quiet sentence
    /// beside the mark and nothing else.
    func testBeingOlderThanTheRuntimeReadsAsOneQuietSentence() {
        XCTAssertNil(PanelState.notice(failure: .invalidResponse))
        XCTAssertNil(PanelState.notice(failure: nil, message: ClientFailure.invalidResponse.message))
        XCTAssertEqual(PanelState.statusNote(.connected, justConnected: false, failure: .invalidResponse),
                       Words.needsNewerCosmos)
        XCTAssertLessThanOrEqual(Words.needsNewerCosmos.count, 40, "one short line, not a paragraph")
        XCTAssertFalse(Words.needsNewerCosmos.hasSuffix("."), "the status line is a line, not a paragraph")
        // Everything else about the connection reads exactly as it did.
        XCTAssertNil(PanelState.statusNote(.connected, justConnected: false, failure: nil))
        XCTAssertEqual(PanelState.statusNote(.connected, justConnected: true, failure: nil), Words.connected)
        XCTAssertEqual(PanelState.statusNote(.reconnecting, justConnected: false, failure: nil),
                       Words.reconnecting)
    }

    func testDigitsPickOnlyTheOptionsCosmosOffered() {
        XCTAssertEqual(PanelState.choiceIndex(digit: "1", count: 3), 0)
        XCTAssertEqual(PanelState.choiceIndex(digit: "3", count: 3), 2)
        XCTAssertNil(PanelState.choiceIndex(digit: "4", count: 3))
        XCTAssertNil(PanelState.choiceIndex(digit: "0", count: 3))
        XCTAssertNil(PanelState.choiceIndex(digit: "9", count: 9), "Cosmos numbers at most eight")
        XCTAssertEqual(PanelState.choiceIndex(digit: "8", count: 8), 7)
        XCTAssertNil(PanelState.choiceIndex(digit: "x", count: 3))
    }

    /// The whole keyboard model in one place: what each combination asks for, and
    /// what it must never claim.
    func testKeyboardModelResolvesEveryPromisedCombination() {
        XCTAssertEqual(PanelState.command(key: "\r", command: true), .send)
        XCTAssertEqual(PanelState.command(key: ".", command: true), .cancelTask)
        XCTAssertEqual(PanelState.command(key: "k", command: true), .destinations)
        XCTAssertEqual(PanelState.command(key: "K", command: true), .destinations)
        XCTAssertEqual(PanelState.command(key: "w", command: true), .close)
        XCTAssertEqual(PanelState.command(key: "l", command: true), .focusAsk)
        XCTAssertEqual(PanelState.command(key: "u", command: true, shift: true), .useSelection)
        XCTAssertEqual(PanelState.command(key: "2", command: true, choiceCount: 3), .choose(1))
        XCTAssertEqual(PanelState.command(key: "8", command: true, choiceCount: 8), .choose(7))
        // Nothing fires without Command, with another modifier, or past the options.
        XCTAssertNil(PanelState.command(key: "k", command: false))
        XCTAssertNil(PanelState.command(key: "k", command: true, option: true))
        XCTAssertNil(PanelState.command(key: "k", command: true, control: true))
        XCTAssertNil(PanelState.command(key: "k", command: true, shift: true),
                     "Shift-Command-K is not a shortcut this panel claims")
        XCTAssertNil(PanelState.command(key: "4", command: true, choiceCount: 3))
        XCTAssertNil(PanelState.command(key: "1", command: true, choiceCount: nil))
        // The standard editing shortcuts belong to the text field, never to the
        // panel; the application's own editing menu resolves them.
        for key in ["a", "c", "v", "x", "z"] {
            XCTAssertNil(PanelState.command(key: key, command: true), "⌘\(key) belongs to the text")
        }
        XCTAssertNil(PanelState.command(key: "z", command: true, shift: true))
        XCTAssertNil(PanelState.command(key: "", command: true))
        // Escape is not a Command combination: the window closes on it, and closing
        // is never cancelling.
        XCTAssertNil(PanelState.command(key: "\u{1b}", command: true))
    }

    func testNoticesSkipCopyThatRestatesTheStage() {
        XCTAssertTrue(PanelState.restatesStage(ClientModel.initialMessage, stage: .setup))
        XCTAssertFalse(PanelState.restatesStage(ClientModel.initialMessage, stage: .approve))
        XCTAssertTrue(PanelState.restatesStage(ClientModel.approveMessage, stage: .approve))
        XCTAssertTrue(PanelState.restatesStage(ClientModel.connectedMessage, stage: .connected))
        XCTAssertFalse(PanelState.restatesStage("Cosmos has your request, to continue on TV.", stage: .connected))
        XCTAssertTrue(PanelState.isFailureMessage(ClientFailure.approvalRequired.message))
        XCTAssertTrue(PanelState.isFailureMessage(ClientFailure.identityUnavailable.message))
        XCTAssertFalse(PanelState.isFailureMessage(ClientModel.connectedMessage))
        XCTAssertFalse(PanelState.isFailureMessage(""))
    }

    /// Every failure the owner can meet reads as one sentence on what happened and one
    /// on what to do. Anything technical is only ever behind Details.
    func testEveryFailureBecomesTwoPlainSentences() throws {
        let technical = ["hash", "digest", "uuid", "json", "generation", "incarnation",
                         "0x", "null", "errsec", "http/", "stack"]
        for failure in PanelState.failures {
            // A client older than the runtime is the one failure the panel says
            // quietly in the status line instead.
            guard failure != .invalidResponse else { continue }
            let notice = try XCTUnwrap(PanelState.notice(failure: failure))
            XCTAssertEqual(notice, failure.notice)
            XCTAssertEqual(PanelState.notice(failure: nil, message: failure.message), failure.notice)
            let next = try XCTUnwrap(notice.next, "\(failure) never says what to do")
            for sentence in [notice.happened, next] {
                XCTAssertTrue(sentence.hasSuffix(".") || sentence.hasSuffix("…"), sentence)
                XCTAssertLessThanOrEqual(sentence.count, 80, "\(sentence) is longer than one calm sentence")
                for token in technical {
                    XCTAssertFalse(sentence.lowercased().contains(token), "\(sentence) leaks \(token)")
                }
            }
        }
        XCTAssertNil(PanelState.notice(failure: nil, message: ""))
        XCTAssertEqual(PanelState.notice(failure: nil, message: "Cosmos has your request."),
                       Notice(happened: "Cosmos has your request."),
                       "a sentence the model already wrote passes through unchanged")
        XCTAssertFalse(ClientFailure.uncertainRequest.notice.isFailure,
                       "an unsettled outcome is information, not a fault")
    }

    /// Both appearances have to be right: no token is defined only for one of them,
    /// and every pairing the panel actually draws clears 4.5:1.
    func testPaletteClearsContrastInLightAndDark() {
        let pairs: [(String, NSColor, NSColor)] = [
            ("primary on background", CosmosTokens.lightPrimary, CosmosTokens.lightBackground),
            ("secondary on background", CosmosTokens.lightSecondary, CosmosTokens.lightBackground),
            ("primary on surface", CosmosTokens.lightPrimary, CosmosTokens.lightSurface),
            ("secondary on surface", CosmosTokens.lightSecondary, CosmosTokens.lightSurface),
            ("accent on surface", CosmosTokens.lightAccent, CosmosTokens.lightSurface),
            ("error on background", CosmosTokens.lightError, CosmosTokens.lightBackground),
            ("white on accent", .white, CosmosTokens.lightAccent),
            ("primary on background (dark)", CosmosTokens.darkPrimary, CosmosTokens.darkBackground),
            ("secondary on background (dark)", CosmosTokens.darkSecondary, CosmosTokens.darkBackground),
            ("primary on surface (dark)", CosmosTokens.darkPrimary, CosmosTokens.darkSurface),
            ("secondary on surface (dark)", CosmosTokens.darkSecondary, CosmosTokens.darkSurface),
            ("accent on surface (dark)", CosmosTokens.darkAccent, CosmosTokens.darkSurface),
            ("error on background (dark)", CosmosTokens.darkError, CosmosTokens.darkBackground),
            ("panel on accent (dark)", CosmosTokens.darkPanel, CosmosTokens.darkAccent),
        ]
        for (name, ink, ground) in pairs {
            XCTAssertGreaterThanOrEqual(CosmosTokens.contrastRatio(ink, ground), 4.5,
                                        "\(name) is below 4.5:1")
        }
        // A dynamic token really resolves to both halves of its pair.
        for (dynamic, light, dark) in [
            (CosmosTokens.backgroundNSColor, CosmosTokens.lightBackground, CosmosTokens.darkBackground),
            (CosmosTokens.primaryNSColor, CosmosTokens.lightPrimary, CosmosTokens.darkPrimary),
            (CosmosTokens.accentNSColor, CosmosTokens.lightAccent, CosmosTokens.darkAccent),
        ] {
            XCTAssertEqual(resolve(dynamic, dark: false), light)
            XCTAssertEqual(resolve(dynamic, dark: true), dark)
        }
        XCTAssertEqual(CosmosTokens.contrastRatio(.white, .white), 1, accuracy: 0.001)
    }

    private func resolve(_ color: NSColor, dark: Bool) -> NSColor? {
        let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        var resolved: NSColor?
        appearance?.performAsCurrentDrawingAppearance { resolved = color.usingColorSpace(.sRGB) }
        return resolved
    }

    /// The nebula belongs to the welcome and empty states and is decorative: it
    /// disappears entirely under Reduce Transparency.
    @MainActor
    func testPanelBackgroundDrawsTheNebulaOnlyWhenAllowed() throws {
        func bottomTint(showTexture: Bool, dark: Bool = true) throws -> (red: CGFloat, green: CGFloat, blue: CGFloat) {
            let renderer = ImageRenderer(content: ZStack {
                dark ? Color.black : Color.white
                PanelBackground(showTexture: showTexture)
            }
                .environment(\.colorScheme, dark ? .dark : .light)
                .frame(width: CosmosTokens.panelWidth, height: 400))
            renderer.scale = 1
            let image = try XCTUnwrap(renderer.cgImage)
            let bitmap = NSBitmapImageRep(cgImage: image)
            let pixel = try XCTUnwrap(bitmap.colorAt(x: image.width / 2, y: image.height - 60))
            let color = try XCTUnwrap(pixel.usingColorSpace(.sRGB))
            return (color.redComponent, color.greenComponent, color.blueComponent)
        }
        let plain = try bottomTint(showTexture: false)
        XCTAssertLessThan(plain.blue, 0.2, "without the texture the bottom is the flat kit ground")
        let textured = try bottomTint(showTexture: true)
        XCTAssertGreaterThan(textured.blue, plain.blue + 0.1, "the nebula glows cyan along the bottom")
        XCTAssertGreaterThan(textured.green, plain.green + 0.1)
        XCTAssertLessThan(textured.red, textured.blue, "the glow is the kit's cyan, not a wash-out")
        // On a light ground the same cloud has to stay a hint, or it washes out the
        // controls that sit over it.
        let lightPlain = try bottomTint(showTexture: false, dark: false)
        let lightTextured = try bottomTint(showTexture: true, dark: false)
        XCTAssertLessThan(lightTextured.blue - lightPlain.blue, textured.blue - plain.blue,
                          "the nebula is quieter on a light ground than on the graphite one")
        XCTAssertGreaterThan(lightTextured.red, 0.5, "light stays light under the texture")
        XCTAssertLessThan(CosmosTokens.nebulaOpacity.light, CosmosTokens.nebulaOpacity.dark)
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

    /// Each presence is a distinct template image at the same size: no colour, and
    /// never the same picture for two different states.
    @MainActor
    func testPresenceIconsAreDistinctTemplatesOfOneSize() throws {
        var seen: [Data] = []
        for presence in [MenuPresence.quiet, .working, .waiting] {
            let icon = CosmosResources.menuBarIcon(presence)
            XCTAssertTrue(icon.isTemplate, "\(presence) must stay a template image")
            XCTAssertEqual(icon.size, NSSize(width: 20, height: 16))
            let rendered = try XCTUnwrap(icon.tiffRepresentation)
            for other in seen {
                XCTAssertNotEqual(rendered, other, "\(presence) draws the same glyph as another state")
            }
            seen.append(rendered)
        }
    }

    /// Nothing the owner reads carries an identifier, a digest or a piece of JSON.
    func testTheWordsFileStaysFreeOfTechnicalVocabulary() throws {
        let mirror = [
            Words.setupTitle, Words.setupLede, Words.setupAction, Words.approveTitle, Words.approveLede,
            Words.approveWaiting, Words.needsNewerCosmos, Words.contextExplains,
            Words.accessibilityOff, Words.accessibilityAction, Words.connectedLede,
            Words.cannotConfirmDetail, Words.nowhereDetail, Words.attachText,
            Words.exampleCafes, Words.exampleNotes, Words.exampleSelection,
        ]
        let technical = ["hash", "digest", "uuid", "json", "generation", "incarnation", "fence", "0x"]
        for sentence in mirror {
            XCTAssertFalse(sentence.isEmpty)
            for token in technical {
                XCTAssertFalse(sentence.lowercased().contains(token), "\(sentence) leaks \(token)")
            }
        }
        XCTAssertEqual(Words.usingSelection("Mail"), "Using: Mail selection")
        XCTAssertEqual(Words.destinationChip("Shield TV"), "→ Shield TV")
        XCTAssertEqual(Words.shownOn("your phone"), "Shown on your phone")
        XCTAssertEqual(Words.chooseHint(3), "Press 1–3 or ↑↓ then ↩ to pick one.")
        XCTAssertEqual(Words.chooseHint(12), "Press 1–8 or ↑↓ then ↩ to pick one.")
    }
}
