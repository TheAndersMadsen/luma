import AppKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor
public struct AssistantPanel: View {
    @ObservedObject private var model: ClientModel
    public init(model: ClientModel) { self.model = model }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Cosmos").font(.largeTitle.weight(.semibold))
                    Spacer()
                    Text("PUBLIC TEXT").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                }
                Label(model.statusText, systemImage: model.snapshot.phase == .connected ? "network" : "circle.dotted")
                    .font(.callout).accessibilityIdentifier("connection-status")

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
                            Button("Open Center approval") {
                                if let url = model.selectedServer?.surfacesURL { NSWorkspace.shared.open(url) }
                            }
                            Text("In Center, approve this installation and a browser tab as a shared display.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        HStack {
                            Button(model.snapshot.needsReconnect || model.snapshot.pendingOpen ? "Reconnect" : "Connect", action: model.connect)
                                .disabled(!model.canConnect)
                            Button("Disconnect", action: model.disconnect).disabled(!model.canDisconnect)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Ask Cosmos").font(.headline)
                    Text("Responses currently appear on your approved Center display.")
                        .font(.callout).foregroundStyle(.secondary)
                    TextEditor(text: $model.draft)
                        .font(.body).frame(minHeight: 88, maxHeight: 160)
                        .padding(6).background(.background, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
                        .disabled(model.snapshot.phase != .connected || model.snapshot.hasPending
                            || model.snapshot.pendingOpen || model.snapshot.needsReconnect || model.busy)
                        .accessibilityLabel("Public request").accessibilityIdentifier("public-request")
                    HStack {
                        Button("Send public text", action: model.send)
                            .buttonStyle(.borderedProminent).disabled(!model.canSend)
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
                        Text(model.message).font(.callout).accessibilityIdentifier("operation-status")
                    }
                }
                Text("This shared-text preview has no microphone, screen capture, private retrieval, or native response display.")
                    .font(.caption).foregroundStyle(.secondary)
                if !model.shortcutMessage.isEmpty {
                    Text(model.shortcutMessage).font(.caption).foregroundStyle(.secondary)
                }
            }.padding(22)
        }.frame(minWidth: 420, idealWidth: 440, maxWidth: 520, minHeight: 540, idealHeight: 700)
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
