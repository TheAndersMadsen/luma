import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import UniformTypeIdentifiers

@MainActor
public struct AssistantPanel: View {
    @ObservedObject private var model: ClientModel
    public init(model: ClientModel) { self.model = model }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 12) {
                    Image(systemName: "moon.fill")
                        .font(.title3)
                        .foregroundStyle(CosmosPanelPalette.primary)
                        .frame(width: 36, height: 36)
                        .background(CosmosPanelPalette.panel, in: Circle())
                        .accessibilityHidden(true)
                    Text("Cosmos").font(.largeTitle.weight(.semibold))
                    Spacer()
                    Text("PUBLIC TEXT")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(CosmosPanelPalette.secondary)
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(CosmosPanelPalette.surface, in: Capsule())
                }
                Label(model.statusText, systemImage: model.snapshot.phase == .connected ? "network" : "circle.dotted")
                    .font(.callout).accessibilityIdentifier("connection-status")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(CosmosPanelPalette.surface, in: RoundedRectangle(cornerRadius: 12))

                GroupBox("Installation") {
                    VStack(alignment: .leading, spacing: 10) {
                        TextField("HTTPS server address", text: $model.serverInput)
                            .textFieldStyle(.roundedBorder).disabled(!model.canEditServer)
                            .accessibilityIdentifier("server-address")
                        Button("Prepare installation", action: model.prepare).disabled(!model.canPrepare)
                        if let descriptor = model.descriptor {
                            Text("Public-key fingerprint").font(.caption).foregroundStyle(.secondary)
                            Text(descriptor.fingerprint).font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("installation-fingerprint")
                            HStack {
                                Button("Copy public descriptor", action: copyDescriptor)
                                Button("Save…", action: saveDescriptor)
                                    .accessibilityLabel("Save public descriptor")
                            }
                            if let approval = approvalURL {
                                if let code = QRCodeImage.render(approval.absoluteString) {
                                    Image(nsImage: code)
                                        .interpolation(.none)
                                        .resizable()
                                        .frame(width: 160, height: 160)
                                        .background(Color.white, in: RoundedRectangle(cornerRadius: 8))
                                        .accessibilityLabel("Approval QR code for Center")
                                }
                                Text("Scan with your phone, or open the link here. Center shows the same fingerprint; approve only if they match.")
                                    .font(.caption).foregroundStyle(.secondary)
                                Button("Approve in Center") { NSWorkspace.shared.open(approval) }
                            }
                        }
                        HStack {
                            Button(model.snapshot.needsReconnect || model.snapshot.pendingOpen ? "Reconnect" : "Connect", action: model.connect)
                                .disabled(!model.canConnect)
                            Button("Disconnect", action: model.disconnect).disabled(!model.canDisconnect)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
                }

                if let card = model.display {
                    DisplayCardView(card: card)
                        .onAppear { model.displayCommitted(card) }
                        .id(card.actionID)
                }
                if let speech = model.speech {
                    VStack(alignment: .leading, spacing: 6) {
                        Label(model.speaking ? "Speaking" : "Spoken reply", systemImage: model.speaking ? "speaker.wave.2.fill" : "speaker.wave.2")
                            .font(.caption.weight(.semibold)).foregroundStyle(CosmosPanelPalette.secondary)
                        Text(speech.text).font(.body).textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("cosmos-speech-text")
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(CosmosPanelPalette.surface, in: RoundedRectangle(cornerRadius: 12))
                    .id(speech.actionID)
                }

                VStack(alignment: .leading, spacing: 12) {
                    Text("Ask Cosmos").font(.headline).foregroundStyle(CosmosPanelPalette.accent)
                    Text(model.snapshot.visible
                        ? "Responses may appear here or on another approved display."
                        : "Responses appear on your approved displays; this panel joins them while visible.")
                        .font(.callout).foregroundStyle(CosmosPanelPalette.secondary)
                    TextEditor(text: $model.draft)
                        .font(.body).frame(minHeight: 88, maxHeight: 160)
                        .scrollContentBackground(.hidden)
                        .padding(8)
                        .background(CosmosPanelPalette.surface, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(CosmosPanelPalette.secondary, lineWidth: 1))
                        .disabled(model.snapshot.phase != .connected || model.snapshot.hasPending
                            || model.snapshot.pendingOpen || model.snapshot.needsReconnect || model.busy)
                        .accessibilityLabel("Public request").accessibilityIdentifier("public-request")
                    HStack {
                        Button("Send public text", action: model.send)
                            .buttonStyle(.borderedProminent)
                            .foregroundStyle(CosmosPanelPalette.panel)
                            .disabled(!model.canSend)
                        Button("Cancel request", action: model.cancel).disabled(!model.canCancel)
                    }
                    if model.draft.utf8.count > 4000 {
                        Text("The request is over the 4,000-byte limit. Shorten it before sending.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if model.snapshot.hasPending || model.snapshot.pendingOpen || model.snapshot.needsReconnect || model.snapshot.canRetry {
                        Text(model.snapshot.needsReconnect || model.snapshot.pendingOpen
                            ? "Reconnect using the retained connection state before sending another request."
                            : "An outcome is uncertain. New requests are paused until the exact pending operation is resolved.")
                            .font(.callout).foregroundStyle(.secondary)
                        Button("Retry pending request", action: model.retryPending).disabled(!model.canRetryPending)
                    }
                    if model.snapshot.hasUnknownOutcome {
                        Text("A previous request has an unknown outcome. It will not be replayed automatically; you can send a new request once connected.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                    if !model.message.isEmpty {
                        Text(model.message).font(.callout)
                            .foregroundStyle(CosmosPanelPalette.response)
                            .accessibilityIdentifier("operation-status")
                    }
                }
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(CosmosPanelPalette.panel, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .stroke(CosmosPanelPalette.accent.opacity(0.7), lineWidth: 1))
                Text("This preview has no microphone, screen capture or private retrieval. Cards and spoken replies here are shared-room content only.")
                    .font(.caption).foregroundStyle(CosmosPanelPalette.secondary)
                if !model.shortcutMessage.isEmpty {
                    Text(model.shortcutMessage).font(.caption).foregroundStyle(.secondary)
                }
            }.padding(22)
        }
        .foregroundStyle(CosmosPanelPalette.primary)
        .tint(CosmosPanelPalette.accent)
        .background(CosmosPanelPalette.background)
        .preferredColorScheme(.dark)
        .frame(minWidth: 420, idealWidth: 440, maxWidth: 520, minHeight: 540, idealHeight: 700)
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

/// Renders the delivered card verbatim. Credits are inert tokens: text or one HTTPS link.
struct DisplayCardView: View {
    let card: DisplayCard

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch card.content {
            case .text(let text):
                Text(text).font(.body).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("cosmos-display-text")
            case .places(let query, let items, let credits):
                Text(query).font(.headline)
                if items.isEmpty {
                    Text("No matching places found.").font(.body)
                } else {
                    ForEach(items, id: \.placeID) { item in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.name).font(.body.weight(.semibold))
                            Text(item.address).font(.body)
                            if let source = item.sourceURL, let url = URL(string: source) {
                                Link("View on Google Maps", destination: url).font(.callout)
                            }
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Google Maps").font(.caption.weight(.semibold))
                    ForEach(Array(credits.enumerated()), id: \.offset) { credit in
                        creditLine(credit.element)
                    }
                }.foregroundStyle(CosmosPanelPalette.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CosmosPanelPalette.surface, in: RoundedRectangle(cornerRadius: 12))
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
        }.font(.caption)
    }
}

private enum CosmosPanelPalette {
    // Palette values from the owner's Cosmos macOS UI kit design-tokens.json.
    static let background = Color(red: 8 / 255, green: 14 / 255, blue: 18 / 255)
    static let surface = Color(red: 17 / 255, green: 27 / 255, blue: 32 / 255)
    static let panel = Color(red: 3 / 255, green: 8 / 255, blue: 9 / 255)
    static let accent = Color(red: 39 / 255, green: 230 / 255, blue: 223 / 255)
    static let response = Color(red: 88 / 255, green: 244 / 255, blue: 241 / 255)
    static let primary = Color(red: 242 / 255, green: 247 / 255, blue: 248 / 255)
    static let secondary = Color(red: 164 / 255, green: 183 / 255, blue: 190 / 255)
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
