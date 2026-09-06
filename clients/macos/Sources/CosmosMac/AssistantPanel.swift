import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import UniformTypeIdentifiers

/// One calm panel with three layouts: set up this Mac, approve it in Center, and
/// the connected assistant. Every state change comes from the model; the view
/// never claims a connection, playback or approval it has not observed.
@MainActor
public struct AssistantPanel: View {
    @ObservedObject private var model: ClientModel
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var editingServer = false
    @State private var advancedShown = false
    @FocusState private var askFocused: Bool

    public init(model: ClientModel) { self.model = model }

    public var body: some View {
        let stage = model.stage
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    switch stage {
                    case .setup: setup
                    case .approve: approve
                    case .connected: connected
                    }
                    notices(stage)
                }
                .padding(.horizontal, CosmosTokens.padding)
                .padding(.top, 6)
                .padding(.bottom, stage == .connected ? 8 : CosmosTokens.padding)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            if stage == .connected { askBar }
        }
        .frame(width: CosmosTokens.panelWidth)
        // The header is designed to share the transparent title bar with the close button.
        .ignoresSafeArea(edges: .top)
        .background { PanelBackground(showTexture: !reduceTransparency) }
        .foregroundStyle(CosmosTokens.primary)
        .tint(CosmosTokens.accent)
        .environment(\.colorScheme, .dark)
        .onChange(of: model.descriptor) { _, descriptor in if descriptor != nil { editingServer = false } }
        .onChange(of: model.panelVisible) { _, visible in if visible, model.stage == .connected { askFocused = true } }
        .onChange(of: stage) { _, value in if value == .connected, model.panelVisible { askFocused = true } }
    }

    // MARK: Header

    /// Sits in the transparent title bar, clear of the window's close button.
    private var header: some View {
        HStack(spacing: 10) {
            CosmosMark(size: 22)
            Text("Cosmos").font(.system(size: 15, weight: .semibold))
            Spacer()
            statusPill
        }
        .frame(height: 28)
        .padding(.top, 2)
        .padding(.leading, 44)
        .padding(.trailing, CosmosTokens.padding)
        .padding(.bottom, 10)
    }

    private var statusPill: some View {
        let status = model.connectionStatus
        let dot: Color = switch status {
        case .connected: CosmosTokens.success
        case .disconnected: CosmosTokens.secondary
        case .connecting, .reconnecting, .disconnecting: CosmosTokens.accent
        }
        return HStack(spacing: 6) {
            Circle().fill(dot).frame(width: 7, height: 7)
            Text(status.label).font(.system(size: 12, weight: .medium))
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(CosmosTokens.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(CosmosTokens.border, lineWidth: 1))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Connection status")
        .accessibilityValue(model.statusText)
        .accessibilityIdentifier("connection-status")
    }

    // MARK: Set up this Mac

    private var setup: some View {
        VStack(alignment: .leading, spacing: 14) {
            title("Set up this Mac")
            lede("This Mac gets its own Cosmos identity, which you approve once in Center.")
            serverRow
            HStack(spacing: 14) {
                Button(action: model.prepare) {
                    Text(model.busy ? "Setting up…" : "Set up this Mac").frame(minWidth: 150)
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .foregroundStyle(CosmosTokens.panel)
                .disabled(!model.canPrepare)
                .accessibilityLabel("Set up this Mac")
                if model.busy {
                    CosmosWaveform(phase: .thinking, active: model.panelVisible).frame(width: 42, height: 26)
                }
            }
            .padding(.top, 4)
            Text("Cosmos has no microphone, screen capture or private retrieval here. Cards and spoken replies are shared-room content.")
                .font(.system(size: 12)).foregroundStyle(CosmosTokens.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4)
        }
    }

    /// The server reads as a host with a Change link; the field appears only on request.
    private var serverRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "network").font(.system(size: 12)).foregroundStyle(CosmosTokens.secondary)
                    .accessibilityHidden(true)
                Text(PanelState.serverSummary(model.serverInput))
                    .font(.system(size: 13)).foregroundStyle(CosmosTokens.secondary)
                    .accessibilityLabel("Server")
                    .accessibilityValue(model.serverInput)
                    .accessibilityIdentifier(editingServer ? "server-summary" : "server-address")
                Text("·").foregroundStyle(CosmosTokens.secondary).accessibilityHidden(true)
                Button(editingServer ? "Done" : "Change") { editingServer.toggle() }
                    .buttonStyle(.link).font(.system(size: 13))
                    .disabled(!model.canEditServer)
                    .accessibilityLabel(editingServer ? "Keep this server" : "Change the server")
            }
            if editingServer {
                TextField("https://center.example", text: $model.serverInput)
                    .textFieldStyle(.roundedBorder).font(.system(size: 13))
                    .disabled(!model.canEditServer)
                    .onSubmit { editingServer = false }
                    .accessibilityLabel("HTTPS server address")
                    .accessibilityIdentifier("server-address")
            }
        }
    }

    // MARK: Approve in Center

    private var approve: some View {
        VStack(alignment: .leading, spacing: 14) {
            title("Approve in Center")
            lede("Center shows this same fingerprint. Approve it there once, then connect.")
            if let descriptor = model.descriptor { fingerprint(descriptor.fingerprint) }
            HStack(alignment: .top, spacing: 18) {
                if let approval = approvalURL, let code = QRCodeImage.render(approval.absoluteString) {
                    Image(nsImage: code)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: 128, height: 128)
                        .padding(6)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .accessibilityLabel("Approval QR code for Center")
                }
                VStack(alignment: .leading, spacing: 10) {
                    Text("Scan with your phone, or open the link")
                        .font(.system(size: 13)).foregroundStyle(CosmosTokens.secondary)
                    if let approval = approvalURL {
                        Button { NSWorkspace.shared.open(approval) } label: {
                            Text("Approve in Center").frame(minWidth: 150)
                        }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                        .foregroundStyle(CosmosTokens.panel)
                        .accessibilityLabel("Approve in Center")
                    }
                    HStack(spacing: 12) {
                        Button(action: model.connect) { Text(connectTitle).frame(minWidth: 150) }
                            .buttonStyle(.bordered).controlSize(.large)
                            .disabled(!model.canConnect)
                            .accessibilityLabel("Connect")
                        if model.busy {
                            CosmosWaveform(phase: .thinking, active: model.panelVisible).frame(width: 42, height: 26)
                        }
                    }
                }
                .padding(.top, 4)
            }
            DisclosureGroup("Advanced", isExpanded: $advancedShown) {
                HStack(spacing: 10) {
                    Button("Copy descriptor", action: copyDescriptor)
                        .accessibilityLabel("Copy public descriptor")
                    Button("Save…", action: saveDescriptor)
                        .accessibilityLabel("Save public descriptor")
                }
                .padding(.top, 8)
            }
            .font(.system(size: 13))
            .foregroundStyle(CosmosTokens.secondary)
            .padding(.top, 2)
        }
    }

    private var connectTitle: String {
        if model.snapshot.phase == .connecting { return "Connecting…" }
        return model.snapshot.needsReconnect || model.snapshot.pendingOpen ? "Reconnect" : "Connect"
    }

    private func fingerprint(_ value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Fingerprint").font(.system(size: 11, weight: .semibold)).foregroundStyle(CosmosTokens.secondary)
            Text(PanelState.groupedFingerprint(value))
                .font(.system(size: 13, weight: .medium, design: .monospaced))
                .lineSpacing(4)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Installation fingerprint")
                .accessibilityIdentifier("installation-fingerprint")
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CosmosTokens.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    // MARK: Connected

    private var connected: some View {
        VStack(alignment: .leading, spacing: 12) {
            responseCard
            HStack(spacing: 16) {
                if model.snapshot.admission != nil {
                    quietButton("Cancel request", action: model.cancel).disabled(!model.canCancel)
                }
                Spacer()
                quietButton("Disconnect", action: model.disconnect)
                    .disabled(!model.canDisconnect)
                    .accessibilityLabel("Disconnect from Cosmos")
            }
        }
    }

    /// The kit's response card: waveform and state on top, live selectable text below.
    private var responseCard: some View {
        let phase = model.waveformPhase
        let label = model.rejoining ? "Rejoining…" : phase.label
        return VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                CosmosWaveform(phase: phase, active: model.panelVisible).frame(width: 42, height: 30)
                Text(label).font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(CosmosTokens.primary.opacity(0.88))
                    .accessibilityLabel("Cosmos is \(label.lowercased())")
                Spacer()
                Text("Cosmos").font(.system(size: 12, weight: .medium)).foregroundStyle(CosmosTokens.secondary)
                    .accessibilityHidden(true)
            }
            if let card = model.display {
                DisplayCardView(card: card)
                    .onAppear { model.displayCommitted(card) }
                    .id(card.actionID)
            }
            if let speech = model.speech {
                VStack(alignment: .leading, spacing: 8) {
                    Label(model.speaking ? "Speaking" : "Spoken reply",
                          systemImage: model.speaking ? "speaker.wave.2.fill" : "speaker.wave.2")
                        .font(.system(size: 12, weight: .semibold)).foregroundStyle(CosmosTokens.secondary)
                    Text(speech.text)
                        .font(.system(size: CosmosTokens.bodySize, weight: .medium)).lineSpacing(5)
                        .foregroundStyle(CosmosTokens.response)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("cosmos-speech-text")
                }
                .id(speech.actionID)
            }
            if model.display == nil, model.speech == nil {
                Text(placeholder)
                    .font(.system(size: CosmosTokens.bodySize, weight: .medium)).lineSpacing(5)
                    .foregroundStyle(CosmosTokens.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(CosmosTokens.padding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CosmosTokens.panel, in: RoundedRectangle(cornerRadius: CosmosTokens.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: CosmosTokens.cardRadius, style: .continuous)
            .strokeBorder(phase == .error ? CosmosTokens.error.opacity(0.7) : CosmosTokens.accent.opacity(0.6), lineWidth: 1))
        .shadow(color: CosmosTokens.accent.opacity(reduceTransparency ? 0 : 0.13), radius: 12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Cosmos response")
    }

    private var placeholder: String {
        if model.rejoining { return "Rejoining your Cosmos connection. Replies appear once it is confirmed." }
        return model.snapshot.visible
            ? "Ask anything. Replies may appear here or on another approved display."
            : "Ask anything. Replies appear on your approved displays; this panel joins them while visible."
    }

    /// Pinned under the response area. Return or Command-Return sends.
    private var askBar: some View {
        VStack(spacing: 6) {
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Ask Cosmos", text: $model.draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: 15))
                    .lineLimit(1...6)
                    .padding(.horizontal, 14).padding(.vertical, 9)
                    .background(CosmosTokens.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(askFocused ? CosmosTokens.accent.opacity(0.7) : CosmosTokens.border, lineWidth: 1))
                    .focused($askFocused)
                    .onSubmit(model.send)
                    .accessibilityLabel("Public request")
                    .accessibilityIdentifier("public-request")
                Button(action: model.send) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 30))
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(CosmosTokens.panel, model.canSend ? CosmosTokens.accent : CosmosTokens.border)
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!model.canSend)
                .help("Send public text (⌘↩)")
                .accessibilityLabel("Send public text")
                .padding(.bottom, 3)
            }
            HStack {
                if model.draft.utf8.count > 4000 {
                    Text("Over the 4,000-byte limit. Shorten the request before sending.")
                        .foregroundStyle(CosmosTokens.error)
                } else if !model.shortcutMessage.isEmpty {
                    Text(model.shortcutMessage)
                }
                Spacer()
                Text("⌘↩ sends")
            }
            .font(.system(size: 11)).foregroundStyle(CosmosTokens.secondary)
        }
        .padding(.horizontal, CosmosTokens.padding)
        .padding(.top, 8)
        .padding(.bottom, 14)
    }

    // MARK: Notices

    /// Failure, pending, retry and unknown-outcome copy stays visible whenever it applies.
    @ViewBuilder
    private func notices(_ stage: PanelStage) -> some View {
        let snapshot = model.snapshot
        let retained = snapshot.needsReconnect || snapshot.pendingOpen
        if let failure = snapshot.failure, failure.message != model.message {
            notice(failure.message, failure: true)
        }
        if snapshot.hasPending || retained || snapshot.canRetry, !model.rejoining {
            VStack(alignment: .leading, spacing: 8) {
                notice(retained
                    ? "Reconnect using the retained connection state before sending another request."
                    : "An outcome is uncertain. New requests are paused until the exact pending operation is resolved.",
                    failure: false)
                if snapshot.canRetry {
                    Button("Retry pending request", action: model.retryPending).disabled(!model.canRetryPending)
                }
            }
        }
        if snapshot.hasUnknownOutcome {
            notice("A previous request has an unknown outcome. It will not be replayed automatically; you can send a new request once connected.",
                   failure: false)
        }
        if !model.message.isEmpty, !PanelState.restatesStage(model.message, stage: stage) {
            notice(model.message, failure: PanelState.isFailureMessage(model.message))
                .accessibilityIdentifier("operation-status")
        }
        if stage != .connected, !model.shortcutMessage.isEmpty {
            Text(model.shortcutMessage).font(.system(size: 11)).foregroundStyle(CosmosTokens.secondary)
        }
    }

    private func notice(_ text: String, failure: Bool) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: failure ? "exclamationmark.circle.fill" : "info.circle")
                .font(.system(size: 12))
                .foregroundStyle(failure ? CosmosTokens.error : CosmosTokens.secondary)
                .padding(.top, 2)
                .accessibilityHidden(true)
            Text(text)
                .font(.system(size: 13))
                .foregroundStyle(failure ? CosmosTokens.error : CosmosTokens.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Pieces

    private func title(_ text: String) -> some View {
        Text(text).font(.system(size: 26, weight: .semibold)).padding(.top, 8)
    }

    private func lede(_ text: String) -> some View {
        Text(text).font(.system(size: 15)).foregroundStyle(CosmosTokens.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func quietButton(_ label: String, action: @escaping @MainActor () -> Void) -> some View {
        Button(label, action: action)
            .buttonStyle(.plain)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(CosmosTokens.secondary)
    }

    private var approvalURL: URL? {
        guard let data = model.publicDescriptorData() else { return nil }
        return model.selectedServer?.approvalURL(descriptorData: data)
    }

    private func copyDescriptor() {
        guard let data = model.publicDescriptorData(), let text = String(data: data, encoding: .utf8) else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }

    private func saveDescriptor() {
        guard let data = model.publicDescriptorData() else { return }
        let panel = NSSavePanel()
        panel.title = "Save public installation descriptor"
        panel.nameFieldStringValue = "cosmos-macos-public-descriptor.json"
        panel.allowedContentTypes = [.json]
        panel.canCreateDirectories = true
        panel.begin { result in
            guard result == .OK, let url = panel.url else { return }
            do { try data.write(to: url, options: .atomic) }
            catch { Task { @MainActor in model.exportFailed() } }
        }
    }
}

/// The kit background: flat panel color with the static nebula texture along the
/// bottom. The texture is decorative and disappears under Reduce Transparency.
@MainActor
struct PanelBackground: View {
    var showTexture: Bool

    var body: some View {
        ZStack(alignment: .bottom) {
            CosmosTokens.background
            if showTexture, let nebula = CosmosResources.nebula {
                Image(nsImage: nebula)
                    .resizable()
                    .scaledToFit()
                    .opacity(CosmosTokens.nebulaOpacity)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
        .ignoresSafeArea()
    }
}

/// Renders the delivered card verbatim. Credits are inert tokens: text or one HTTPS link.
struct DisplayCardView: View {
    let card: DisplayCard

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch card.content {
            case .text(let text):
                Text(text)
                    .font(.system(size: CosmosTokens.bodySize, weight: .medium)).lineSpacing(5)
                    .foregroundStyle(CosmosTokens.response)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("cosmos-display-text")
            case .places(let query, let items, let credits):
                Text(query)
                    .font(.system(size: CosmosTokens.bodySize, weight: .semibold))
                    .foregroundStyle(CosmosTokens.response)
                if items.isEmpty {
                    Text("No matching places found.").font(.system(size: 15))
                } else {
                    ForEach(items, id: \.placeID) { item in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.name).font(.system(size: 15, weight: .semibold))
                            Text(item.address).font(.system(size: 15)).foregroundStyle(CosmosTokens.secondary)
                            if let source = item.sourceURL, let url = URL(string: source) {
                                Link("View on Google Maps", destination: url).font(.system(size: 13))
                            }
                        }
                        .textSelection(.enabled)
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Google Maps").font(.system(size: 11, weight: .semibold))
                    ForEach(Array(credits.enumerated()), id: \.offset) { credit in
                        creditLine(credit.element)
                    }
                }.foregroundStyle(CosmosTokens.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Cosmos display")
    }

    private func creditLine(_ parts: [CreditPart]) -> Text {
        parts.reduce(Text("")) { line, part in
            switch part {
            case .text(let text): return line + Text(text)
            case .link(let text, let href):
                var link = AttributedString(text)
                link.link = URL(string: href)
                return line + Text(link)
            }
        }.font(.system(size: 11))
    }
}

/// Renders one QR code from the approval link. The link carries only the public
/// descriptor; rendering it locally sends nothing anywhere.
enum QRCodeImage {
    static func render(_ text: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        let representation = NSCIImageRep(ciImage: scaled)
        let image = NSImage(size: representation.size)
        image.addRepresentation(representation)
        return image
    }
}
