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
    @ObservedObject private var commands: PanelCommands
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var editingServer = false
    @State private var detailsShown = false
    @State private var focusedChoice: Int?
    /// Whether the ask bar's own attach choices are open.
    @State private var attachShown = false
    @FocusState private var askFocused: Bool
    /// Hiding the panel is not cancelling the turn; the controller owns the window.
    var onClose: (@MainActor () -> Void)?

    public init(model: ClientModel, commands: PanelCommands? = nil,
                onClose: (@MainActor () -> Void)? = nil) {
        self.model = model
        self.commands = commands ?? PanelCommands()
        self.onClose = onClose
    }

    public var body: some View {
        let stage = model.stage
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    switch stage {
                    case .setup: setup
                    case .approve: approve
                    case .connected: connected
                    }
                    notices(stage)
                }
                .padding(.horizontal, CosmosTokens.padding)
                .padding(.top, 2)
                .padding(.bottom, stage == .connected ? 6 : CosmosTokens.padding)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            if stage == .connected { askBar }
        }
        .frame(width: CosmosTokens.panelWidth)
        .background { PanelBackground(showTexture: !reduceTransparency && showsNebula) }
        .clipShape(RoundedRectangle(cornerRadius: CosmosTokens.windowRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: CosmosTokens.windowRadius, style: .continuous)
                .strokeBorder(CosmosTokens.border.opacity(0.7), lineWidth: 1)
        }
        .foregroundStyle(CosmosTokens.primary)
        .tint(CosmosTokens.accent)
        .animation(reduceMotion ? nil : .easeOut(duration: CosmosTokens.motionDuration), value: model.nowLine)
        .animation(reduceMotion ? nil : .easeOut(duration: CosmosTokens.motionDuration), value: model.connectionNote)
        .animation(reduceMotion ? nil : .easeOut(duration: CosmosTokens.motionDuration), value: model.taskCard)
        .onChange(of: model.descriptor) { _, descriptor in if descriptor != nil { editingServer = false } }
        .onChange(of: model.panelVisible) { _, visible in if visible { askFocused = model.stage == .connected } }
        .onChange(of: stage) { _, value in if value == .connected, model.panelVisible { askFocused = true } }
        .onChange(of: model.display?.actionID) { _, _ in focusedChoice = nil }
        .onChange(of: commands.focusRequests) { _, _ in askFocused = model.stage == .connected }
    }

    /// The ask field wears its focus ring only while this window actually takes keys.
    private var asking: Bool { askFocused && commands.windowIsKey }

    /// The nebula belongs to the welcome screens, where there is room for it.
    /// A quiet connected panel is the ask field and nothing else, so the nebula
    /// would sit behind the one thing on it.
    private var showsNebula: Bool { model.stage != .connected }

    /// Something about the room itself is unresolved and the owner may have to act.
    private var needsAttention: Bool {
        model.snapshot.failure != nil || model.snapshot.hasPending
            || model.snapshot.needsReconnect || model.snapshot.pendingOpen
    }

    /// Anything about the turn in hand: a reply, a state, or the request that
    /// has just left. The response card exists exactly when one of them does.
    private var hasResponse: Bool {
        model.display != nil || model.speech != nil || model.statusLine != nil
            || model.nowLine != nil || model.sending
    }

    /// Nothing has been asked and nothing is happening here. The panel is then
    /// the mark, the ask field and one row of suggestions: nothing to read.
    private var isEmptyState: Bool {
        !hasResponse && model.ceremony == nil && model.taskCard == nil
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            CosmosMark(size: 20)
            Text(Words.appName).font(.system(size: 13, weight: .medium))
            if let note = model.connectionNote {
                Text(note)
                    .font(.system(size: 12))
                    .foregroundStyle(CosmosTokens.secondary)
                    .transition(.opacity)
                    .accessibilityIdentifier("connection-status")
                    .accessibilityLabel("Connection")
                    .accessibilityValue(model.statusText)
            }
            Spacer()
            if model.stage == .connected {
                CosmosWaveform(phase: model.waveformPhase, active: model.panelVisible)
                    .frame(width: 34, height: 16)
                    .opacity(model.waveformPhase.animated ? 1 : 0)
            }
            closeButton
        }
        .padding(.horizontal, CosmosTokens.padding)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .accessibilityElement(children: .contain)
    }

    private var closeButton: some View {
        Button { onClose?() } label: {
            Image(systemName: "xmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(CosmosTokens.secondary)
                .frame(width: 20, height: 20)
                .background(CosmosTokens.surface.opacity(0.8), in: Circle())
        }
        .buttonStyle(.plain)
        .help("\(Words.close) (esc)")
        .accessibilityLabel(Words.close)
        .accessibilityIdentifier("close-panel")
    }

    // MARK: Set up this Mac

    private var setup: some View {
        VStack(alignment: .leading, spacing: 12) {
            step(Words.stepOne)
            title(Words.setupTitle)
            lede(Words.setupLede)
            serverRow
            HStack(spacing: 12) {
                Button(action: model.prepare) {
                    Text(model.busy ? Words.setupWorking : Words.setupAction).frame(minWidth: 150)
                }
                .buttonStyle(PrimaryButton())
                .disabled(!model.canPrepare)
                .accessibilityLabel(Words.setupAction)
                if model.busy { progressDot }
            }
            .padding(.top, 2)
        }
    }

    /// The server reads as a host with a Change link; the field appears only on request.
    private var serverRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(Words.serverLabel).font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(CosmosTokens.secondary)
                    .accessibilityHidden(true)
                Text(PanelState.serverSummary(model.serverInput))
                    .font(.system(size: 13)).foregroundStyle(CosmosTokens.secondary)
                    .accessibilityLabel("Server")
                    .accessibilityValue(model.serverInput)
                    .accessibilityIdentifier(editingServer ? "server-summary" : "server-address")
                Button(editingServer ? Words.serverKeep : Words.serverChange) { editingServer.toggle() }
                    .buttonStyle(.link).font(.system(size: 13))
                    .disabled(!model.canEditServer)
                    .accessibilityLabel(editingServer ? "Keep this server" : "Change the server")
            }
            if editingServer {
                TextField(Words.serverPlaceholder, text: $model.serverInput)
                    .textFieldStyle(.roundedBorder).font(.system(size: 13))
                    .frame(maxWidth: 320)
                    .disabled(!model.canEditServer)
                    .onSubmit { editingServer = false }
                    .accessibilityLabel("HTTPS server address")
                    .accessibilityIdentifier("server-address")
            }
        }
    }

    // MARK: Approve in Center

    private var approve: some View {
        VStack(alignment: .leading, spacing: 12) {
            step(Words.stepTwo)
            title(Words.approveTitle)
            lede(Words.approveLede)
            HStack(alignment: .top, spacing: 16) {
                if let approval = approvalURL, let code = QRCodeImage.render(approval.absoluteString) {
                    Image(nsImage: code)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: 116, height: 116)
                        .padding(6)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .accessibilityLabel("Approval QR code for Center")
                }
                VStack(alignment: .leading, spacing: 10) {
                    if let approval = approvalURL {
                        Button { NSWorkspace.shared.open(approval) } label: {
                            Text(Words.approveAction).frame(minWidth: 150)
                        }
                        .buttonStyle(PrimaryButton())
                        .accessibilityLabel(Words.approveAction)
                    }
                    HStack(spacing: 10) {
                        Button(action: model.connect) { Text(connectTitle).frame(minWidth: 110) }
                            .buttonStyle(SecondaryButton())
                            .disabled(!model.canConnect)
                            .accessibilityLabel(Words.connectNow)
                        if model.busy { progressDot }
                    }
                    Text(Words.approveWaiting)
                        .font(.system(size: 12)).foregroundStyle(CosmosTokens.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            DisclosureGroup(Words.details, isExpanded: $detailsShown) {
                VStack(alignment: .leading, spacing: 10) {
                    if let descriptor = model.descriptor { fingerprint(descriptor.fingerprint) }
                    HStack(spacing: 10) {
                        Button(Words.copyDescriptor, action: copyDescriptor)
                            .buttonStyle(SecondaryButton())
                            .accessibilityLabel("Copy public descriptor")
                        Button(Words.saveDescriptor, action: saveDescriptor)
                            .buttonStyle(SecondaryButton())
                            .accessibilityLabel("Save public descriptor")
                    }
                }
                .padding(.top, 8)
            }
            .font(.system(size: 12))
            .foregroundStyle(CosmosTokens.secondary)
            .padding(.top, 2)
        }
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

    private var connectTitle: String {
        if model.snapshot.phase == .connecting { return Words.connecting }
        return model.snapshot.needsReconnect || model.snapshot.pendingOpen ? "Reconnect" : Words.connectNow
    }

    private func fingerprint(_ value: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(Words.fingerprintLabel).font(.system(size: 11, weight: .semibold))
                .foregroundStyle(CosmosTokens.secondary)
            Text(PanelState.groupedFingerprint(value))
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .lineSpacing(4)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Installation fingerprint")
                .accessibilityIdentifier("installation-fingerprint")
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CosmosTokens.surface.opacity(0.7), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // MARK: Connected

    private var connected: some View {
        VStack(alignment: .leading, spacing: 12) {
            // A ceremony is the most urgent thing on this screen, and the task it
            // belongs to sits under it. Neither is affected by closing the panel.
            if let ceremony = model.ceremony, let request = model.snapshot.confirmation {
                ConfirmCardView(
                    card: ceremony,
                    totalSeconds: Int(TaskCard.grantMs / 1000),
                    remainingSeconds: TaskCard.remainingSeconds(request.expiresAtMs, now: model.clock),
                    confirm: { model.answerCeremony(granted: true) },
                    decline: { model.answerCeremony(granted: false) }
                )
                .transition(.opacity)
            } else if let card = model.taskCard {
                TaskCardView(card: card, output: model.taskOutput,
                             outputTitle: Words.outputFrom(model.taskLabel ?? Words.appName),
                             cancel: model.cancelTask)
                    .transition(.opacity)
            }
            if hasResponse { responseCard }
            // A quiet, empty panel offers only the ask field; the room's own controls
            // appear once there is a turn to act on, or a room state to get out of.
            // The panel never leaves the owner looking at a problem with no action.
            if !isEmptyState || needsAttention {
                HStack(spacing: 14) {
                    // A command running here has its own Cancel task on the card,
                    // and one control with that name is enough.
                    if model.snapshot.admission != nil, !model.canCancelTask {
                        Button(Words.cancelTask, action: model.cancel)
                            .buttonStyle(QuietButton())
                            .keyboardShortcut(".", modifiers: .command)
                            .disabled(!model.canCancel)
                            .help("\(Words.cancelTask) (⌘.)")
                            .accessibilityLabel(Words.cancelTask)
                    }
                    recoveryActions
                    Spacer()
                    if model.canDisconnect {
                        Button(Words.disconnect, action: model.disconnect)
                            .buttonStyle(QuietButton())
                            .accessibilityLabel("Disconnect from Cosmos")
                    }
                }
            }
        }
    }

    /// The kit's response card: the state on top, the Now line under it, the delivered
    /// content below. Selectable, one comfortable reading column, scrolls with the panel.
    private var responseCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let line = model.statusLine ?? workingLine { statusLine(line) }
            if let now = model.nowLine { nowRow(now) }
            if let card = model.display {
                DisplayCardView(card: card, focused: focusedChoice, pick: pick)
                    .onAppear { model.displayCommitted(card) }
                    .id(card.actionID)
            }
            if let speech = model.speech {
                VStack(alignment: .leading, spacing: 6) {
                    Label(model.speaking ? Words.speaking : Words.spokenReply,
                          systemImage: model.speaking ? "speaker.wave.2.fill" : "speaker.wave.2")
                        .font(.system(size: 11, weight: .semibold)).foregroundStyle(CosmosTokens.secondary)
                    Text(speech.text)
                        .font(.system(size: CosmosTokens.bodySize)).lineSpacing(6)
                        .foregroundStyle(CosmosTokens.primary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: CosmosTokens.readingWidth, alignment: .leading)
                        .accessibilityIdentifier("cosmos-speech-text")
                }
                .id(speech.actionID)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CosmosTokens.surface.opacity(0.7),
                    in: RoundedRectangle(cornerRadius: CosmosTokens.cardRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: CosmosTokens.cardRadius, style: .continuous)
            .strokeBorder(CosmosTokens.border.opacity(0.8), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Cosmos response")
    }

    /// The panel says "Working" from the moment a request leaves, before Cosmos has
    /// reported anything of its own.
    private var workingLine: StatusLine? {
        model.sending || model.nowLine != nil ? StatusLine(title: Words.working) : nil
    }

    private func nowRow(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(Words.now).font(.system(size: 11, weight: .semibold))
                .foregroundStyle(CosmosTokens.secondary)
            Text(text)
                .font(.system(size: 14)).lineSpacing(4)
                .foregroundStyle(CosmosTokens.primary.opacity(0.9))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: CosmosTokens.readingWidth, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Your request")
        .accessibilityValue(text)
        .accessibilityIdentifier("now-line")
    }

    /// Cosmos's own report of the turn, repeated in the shared state vocabulary.
    /// Informational throughout: "Cannot confirm" is a fact about the turn, not a fault.
    private func statusLine(_ line: StatusLine) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: statusSymbol)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(CosmosTokens.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(line.title).font(.system(size: 13, weight: .semibold))
                if let detail = line.detail {
                    Text(detail).font(.system(size: 12)).foregroundStyle(CosmosTokens.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Request status")
        .accessibilityValue(line.detail.map { "\(line.title). \($0)" } ?? line.title)
        .accessibilityIdentifier("turn-status")
    }

    private var statusSymbol: String {
        switch model.snapshot.status?.state {
        case .working, .acting, nil: "circle.dotted"
        case .waiting, .confirming: "clock"
        case .shown, .done: "checkmark.circle"
        case .spoken: "speaker.wave.2"
        case .nowhere: "rectangle.slash"
        case .refused: "xmark.circle"
        case .unknown: "questionmark.circle"
        }
    }

    // MARK: Ask bar

    /// Pinned under the response area: one field, the two things that go with it,
    /// and nothing to read. Return or Command-Return sends.
    private var askBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let line = model.listeningLine { listeningRow(line) }
            HStack(alignment: .bottom, spacing: 8) {
                attachButton
                TextField(Words.askPlaceholder, text: $model.draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14))
                    .lineLimit(1...6)
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(CosmosTokens.surface.opacity(0.9),
                                in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(asking ? CosmosTokens.accent : CosmosTokens.border,
                                      lineWidth: asking ? 2 : 1))
                    .focused($askFocused)
                    .onSubmit(model.send)
                    .onKeyPress(.upArrow) { moveChoice(-1) }
                    .onKeyPress(.downArrow) { moveChoice(1) }
                    .onKeyPress(.return) { takeChoice() }
                    .accessibilityLabel(Words.askPlaceholder)
                    .accessibilityIdentifier("public-request")
                sendButton
            }
            HStack(spacing: 8) {
                if model.draft.utf8.count > 4000 {
                    Text(Words.overLimit)
                        .font(.system(size: 11)).foregroundStyle(CosmosTokens.error)
                } else if let chip = model.context {
                    contextChip(chip)
                } else if showsSuggestions {
                    suggestions
                }
                Spacer(minLength: 8)
                destinationChip
            }
        }
        .padding(.horizontal, CosmosTokens.padding)
        .padding(.top, 10)
        .padding(.bottom, 14)
        .animation(reduceMotion ? nil : .easeOut(duration: CosmosTokens.motionDuration),
                   value: showsSuggestions)
    }

    // MARK: Listening

    /// Two indicators, never at the same time. A hollow ring while this Mac is
    /// waiting for the phrase, and a filled cyan dot that breathes while it is
    /// recording the request that followed it. Under the first one stand the
    /// two things about listening on a laptop that no client can change.
    private func listeningRow(_ line: StatusLine) -> some View {
        let capturing = model.capturingRequest
        let open = model.listeningOpen
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                ListeningDot(active: capturing, open: open, reduceMotion: reduceMotion)
                VStack(alignment: .leading, spacing: 1) {
                    Text(line.title)
                        .font(.system(size: 12, weight: capturing ? .semibold : .medium))
                        .foregroundStyle(capturing ? CosmosTokens.accent : CosmosTokens.secondary)
                    if let detail = line.detail {
                        Text(detail)
                            .font(.system(size: 11))
                            .foregroundStyle(CosmosTokens.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 8)
                if case .blocked(.microphoneDenied) = model.listening {
                    Button(Words.openMicrophoneSettings) {
                        NSWorkspace.shared.open(SystemSettings.microphone)
                    }
                    .buttonStyle(QuietButton())
                }
            }
            // Said here, where the switch is, rather than found out later.
            if !capturing {
                Text("\(Words.listeningStaysHere) \(Words.listeningIsVisible) \(Words.listeningEndsWithTheLid)")
                    .font(.system(size: 10))
                    .foregroundStyle(CosmosTokens.secondary.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: CosmosTokens.readingWidth, alignment: .leading)
            }
        }
        .padding(.bottom, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Words.listening)
        .accessibilityValue(line.detail.map { "\(line.title). \($0)" } ?? line.title)
        .accessibilityIdentifier("listening")
        .animation(reduceMotion ? nil : .easeOut(duration: CosmosTokens.motionDuration), value: capturing)
    }

    /// The suggestions: one row of small chips, each the whole request it sends.
    /// They are there to start from, so they go the moment there is a draft.
    private var showsSuggestions: Bool {
        isEmptyState && model.draft.isEmpty && model.context == nil
    }

    private var suggestions: some View {
        HStack(spacing: 6) {
            ForEach(PanelState.examplePrompts(canReadSelection: model.canReadSelection), id: \.self) { prompt in
                Button {
                    model.draft = prompt
                    askFocused = true
                } label: {
                    Text(prompt)
                        .font(.system(size: 11))
                        .foregroundStyle(CosmosTokens.secondary)
                        .padding(.horizontal, 9).padding(.vertical, 4)
                        .background(CosmosTokens.surface.opacity(0.8), in: Capsule())
                        .overlay(Capsule().strokeBorder(CosmosTokens.border, lineWidth: 1))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Ask: \(prompt)")
            }
        }
        .transition(.opacity)
        .accessibilityIdentifier("example-prompts")
    }

    private var sendButton: some View {
        Button(action: model.send) {
            ZStack {
                Circle().fill(model.canSend ? CosmosTokens.accent : CosmosTokens.border.opacity(0.6))
                    .frame(width: 28, height: 28)
                if model.sending {
                    ProgressView().controlSize(.small).scaleEffect(0.6)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(model.canSend ? CosmosTokens.onAccent : CosmosTokens.secondary)
                }
            }
        }
        .buttonStyle(.plain)
        .keyboardShortcut(.return, modifiers: .command)
        .disabled(!model.canSend)
        .help("\(Words.send) (⌘↩)")
        .accessibilityLabel(model.sending ? Words.sending : Words.send)
        .accessibilityIdentifier("send")
        .padding(.bottom, 4)
    }

    /// One small affordance for the two ways to attach text, so the ask bar
    /// carries a control rather than two labels. Nothing is read until one of
    /// them is used, and ⇧⌘U still takes the selection without opening it.
    private var attachButton: some View {
        Button { attachShown.toggle() } label: {
            Image(systemName: "plus")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(CosmosTokens.secondary)
                .frame(width: 28, height: 28)
                .background(CosmosTokens.surface.opacity(0.8), in: Circle())
                .overlay(Circle().strokeBorder(CosmosTokens.border, lineWidth: 1))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!model.capabilities.context)
        .help("\(Words.attachText) (⇧⌘U for the selection)")
        .accessibilityLabel(Words.attachText)
        .accessibilityIdentifier("attach-text")
        .padding(.bottom, 4)
        .popover(isPresented: $attachShown, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 2) {
                attachChoice(Words.useSelection, symbol: "text.cursor") { model.useSelection() }
                attachChoice(Words.useClipboard, symbol: "doc.on.clipboard") { model.useClipboard() }
            }
            .padding(6)
            .frame(width: 190)
        }
    }

    private func attachChoice(_ title: String, symbol: String,
                              action: @escaping @MainActor () -> Void) -> some View {
        Button {
            attachShown = false
            action()
            askFocused = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: symbol).font(.system(size: 11)).frame(width: 14)
                    .accessibilityHidden(true)
                Text(title).font(.system(size: 13))
                Spacer(minLength: 12)
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }

    /// "Using: Safari selection ×" once text is attached. What it means is on the
    /// chip itself, not spelled out beside it.
    private func contextChip(_ chip: ContextChip) -> some View {
        HStack(spacing: 6) {
            Image(systemName: chip.source == .selection ? "text.cursor" : "doc.on.clipboard")
                .font(.system(size: 10)).accessibilityHidden(true)
            Text(chip.caption).font(.system(size: 11, weight: .medium))
            Button(action: model.clearContext) {
                Image(systemName: "xmark").font(.system(size: 9, weight: .bold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(CosmosTokens.secondary)
            .help(Words.removeContext)
            .accessibilityLabel(Words.removeContext)
        }
        .padding(.horizontal, 9).padding(.vertical, 4)
        .background(CosmosTokens.accent.opacity(0.12), in: Capsule())
        .overlay(Capsule().strokeBorder(CosmosTokens.accent.opacity(0.5), lineWidth: 1))
        .help("\(Words.contextExplains) \(chip.label).")
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Attached text")
        .accessibilityValue("\(chip.label) from \(chip.app). \(Words.contextExplains)")
        .accessibilityIdentifier("context-chip")
    }

    /// The destination is visible before sending and never a surprise. Plain kinds of
    /// device: Cosmos alone knows which displays are approved and free.
    private var destinationChip: some View {
        Button { commands.destinationsShown.toggle() } label: {
            HStack(spacing: 5) {
                Text(Words.destinationChip(model.destination.label))
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 8))
                    .accessibilityHidden(true)
            }
            .font(.system(size: 11, weight: .medium))
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(CosmosTokens.surface.opacity(0.8), in: Capsule())
            .overlay(Capsule().strokeBorder(CosmosTokens.border, lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .keyboardShortcut("k", modifiers: .command)
        .help("\(Words.destinationTitle) (⌘K)")
        .accessibilityLabel(Words.destinationTitle)
        .accessibilityValue(model.destination.label)
        .accessibilityIdentifier("destination")
        .popover(isPresented: $commands.destinationsShown, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 2) {
                Text(Words.destinationTitle).font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(CosmosTokens.secondary)
                    .padding(.horizontal, 8).padding(.top, 6).padding(.bottom, 2)
                ForEach(Destination.allCases) { destination in
                    Button {
                        model.destination = destination
                        commands.destinationsShown = false
                        askFocused = true
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: destination == model.destination ? "checkmark" : "")
                                .font(.system(size: 10, weight: .bold))
                                .frame(width: 12)
                                .accessibilityHidden(true)
                            Text(destination.label).font(.system(size: 13))
                            Spacer(minLength: 20)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 5)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(destination.label)
                    .accessibilityAddTraits(destination == model.destination ? [.isSelected] : [])
                }
            }
            .padding(6)
            .frame(width: 190)
        }
    }

    // MARK: Choices by keyboard

    /// ↑ and ↓ move the highlight through the current choice list while the field is
    /// empty; with text in it the arrows still belong to the text.
    private func moveChoice(_ step: Int) -> KeyPress.Result {
        guard model.draft.isEmpty, let count = choiceCount else { return .ignored }
        let current = focusedChoice ?? (step > 0 ? -1 : 0)
        focusedChoice = min(max(current + step, 0), count - 1)
        return .handled
    }

    /// Return picks the highlighted option; without one it belongs to the ask field.
    private func takeChoice() -> KeyPress.Result {
        guard model.draft.isEmpty, let index = focusedChoice else { return .ignored }
        return pick(index) ? .handled : .ignored
    }

    private var choiceCount: Int? {
        if case .choices(_, let items)? = model.display?.content { return items.count }
        return nil
    }

    @discardableResult
    private func pick(_ index: Int) -> Bool {
        let sent = model.choose(index)
        if sent { focusedChoice = nil }
        return sent
    }

    // MARK: Notices

    /// Exactly one notice, or none: what happened and what to do about it. The
    /// model decides which one; older news never stacks on top of it, and a
    /// state the panel already shows is not repeated as prose.
    @ViewBuilder
    private func notices(_ stage: PanelStage) -> some View {
        if let notice = model.notice { noticeView(notice) }
        if stage != .connected, !model.shortcutMessage.isEmpty {
            Text(model.shortcutMessage).font(.system(size: 11)).foregroundStyle(CosmosTokens.secondary)
        }
    }

    /// Whatever can actually move the room forward from here. The panel never leaves
    /// the owner looking at a room state with no action that resolves it.
    @ViewBuilder
    private var recoveryActions: some View {
        if model.snapshot.canRetry {
            Button(Words.retry, action: model.retryPending)
                .buttonStyle(QuietButton())
                .disabled(!model.canRetryPending)
                .accessibilityIdentifier("retry-pending")
        }
        if model.canConnect {
            Button(connectTitle, action: model.connect)
                .buttonStyle(QuietButton())
                .accessibilityIdentifier("reconnect")
        }
        if model.busy { progressDot }
    }

    private func noticeView(_ notice: Notice) -> some View {
        let tint = notice.isFailure ? CosmosTokens.error : CosmosTokens.secondary
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: notice.isFailure ? "exclamationmark.circle" : "info.circle")
                    .font(.system(size: 12)).foregroundStyle(tint)
                    .padding(.top, 1)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(notice.happened).font(.system(size: 13)).foregroundStyle(tint)
                    if let next = notice.next {
                        Text(next).font(.system(size: 13)).foregroundStyle(CosmosTokens.secondary)
                    }
                }
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: CosmosTokens.readingWidth, alignment: .leading)
            }
            if model.accessibilityBlocked {
                Button(Words.openAccessibilitySettings) {
                    NSWorkspace.shared.open(SystemSettings.accessibility)
                }
                .buttonStyle(SecondaryButton())
                .accessibilityIdentifier("open-accessibility-settings")
            }
            if let detail = notice.detail {
                DisclosureGroup(Words.details, isExpanded: $detailsShown) {
                    Text(detail)
                        .font(.system(size: 11)).foregroundStyle(CosmosTokens.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: CosmosTokens.readingWidth, alignment: .leading)
                        .padding(.top, 4)
                }
                .font(.system(size: 11)).foregroundStyle(CosmosTokens.secondary)
                .accessibilityIdentifier("notice-details")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("notice")
    }

    // MARK: Pieces

    private func step(_ text: String) -> some View {
        Text(text).font(.system(size: 11, weight: .semibold))
            .foregroundStyle(CosmosTokens.accent)
            .accessibilityLabel(text)
    }

    private func title(_ text: String) -> some View {
        Text(text).font(.system(size: 24, weight: .semibold))
    }

    private func lede(_ text: String) -> some View {
        Text(text).font(.system(size: 13)).foregroundStyle(CosmosTokens.secondary)
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: CosmosTokens.readingWidth, alignment: .leading)
    }

    private var progressDot: some View {
        ProgressView().controlSize(.small).scaleEffect(0.7)
            .accessibilityHidden(true)
    }

    private var approvalURL: URL? {
        guard let data = model.publicDescriptorData() else { return nil }
        return model.selectedServer?.approvalURL(descriptorData: data)
    }
}

/// One filled action in the kit's accent, with a visible focus ring.
/// The listening indicator itself: a ring while this Mac waits for the phrase,
/// a filled dot that breathes while it records the request. It is the only
/// thing on the panel that moves on its own, so it stands still whenever the
/// owner has asked for less motion.
struct ListeningDot: View {
    let active: Bool
    let open: Bool
    let reduceMotion: Bool
    @State private var breathing = false

    var body: some View {
        ZStack {
            Circle()
                .strokeBorder(open ? CosmosTokens.accent.opacity(0.7) : CosmosTokens.border, lineWidth: 1.5)
                .frame(width: 10, height: 10)
            if active {
                Circle().fill(CosmosTokens.accent).frame(width: 10, height: 10)
                    .scaleEffect(breathing ? 1.0 : 0.55)
                    .opacity(breathing ? 1 : 0.6)
            }
        }
        .frame(width: 12, height: 12)
        .onAppear { start() }
        .onChange(of: active) { _, _ in start() }
        .accessibilityHidden(true)
    }

    private func start() {
        guard active, !reduceMotion else { breathing = false; return }
        breathing = false
        withAnimation(.easeInOut(duration: 0.85).repeatForever(autoreverses: true)) { breathing = true }
    }
}

struct PrimaryButton: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(isEnabled ? CosmosTokens.onAccent : CosmosTokens.secondary)
            .padding(.horizontal, 16).padding(.vertical, 8)
            .background(isEnabled ? CosmosTokens.accent : CosmosTokens.border.opacity(0.5),
                        in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .opacity(configuration.isPressed ? 0.8 : 1)
            .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
}

/// An outlined action for the second choice on a screen.
struct SecondaryButton: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(isEnabled ? CosmosTokens.primary : CosmosTokens.secondary)
            .padding(.horizontal, 14).padding(.vertical, 7)
            .background(CosmosTokens.surface.opacity(0.7),
                        in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(CosmosTokens.border, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.8 : 1)
            .contentShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
}

/// A text-weight action that stays out of the way until it is needed.
struct QuietButton: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(isEnabled ? CosmosTokens.secondary : CosmosTokens.secondary.opacity(0.5))
            .opacity(configuration.isPressed ? 0.7 : 1)
            .contentShape(Rectangle())
    }
}

/// The kit background: the window material, a graphite ground over it, and the static
/// nebula texture along the bottom of a welcome or empty panel.
@MainActor
struct PanelBackground: View {
    var showTexture: Bool
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        ZStack(alignment: .bottom) {
            PanelMaterial()
            CosmosTokens.background
                .opacity(colorScheme == .dark ? CosmosTokens.groundOpacity.dark : CosmosTokens.groundOpacity.light)
            if showTexture, let nebula = CosmosResources.nebula {
                Image(nsImage: nebula)
                    .resizable()
                    .scaledToFit()
                    .opacity(colorScheme == .dark
                        ? CosmosTokens.nebulaOpacity.dark : CosmosTokens.nebulaOpacity.light)
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
    /// The option the keyboard is currently on, if any.
    var focused: Int?
    /// Sends the option's own title as the next request; the runtime owns the meaning.
    var pick: ((Int) -> Bool)?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if card.isPrivate {
                Label(Words.privateReply, systemImage: "lock.fill")
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(CosmosTokens.secondary)
                    .accessibilityIdentifier("private-reply")
            }
            switch card.content {
            case .text(let text):
                Text(text)
                    .font(.system(size: CosmosTokens.bodySize)).lineSpacing(6)
                    .foregroundStyle(CosmosTokens.primary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: CosmosTokens.readingWidth, alignment: .leading)
                    .accessibilityIdentifier("cosmos-display-text")
            case .places(let query, let items, let credits):
                Text(query)
                    .font(.system(size: CosmosTokens.bodySize, weight: .semibold))
                    .frame(maxWidth: CosmosTokens.readingWidth, alignment: .leading)
                if items.isEmpty {
                    Text(Words.noPlaces).font(.system(size: 14)).foregroundStyle(CosmosTokens.secondary)
                } else {
                    ForEach(items, id: \.placeID) { item in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.name).font(.system(size: 14, weight: .semibold))
                            Text(item.address).font(.system(size: 13)).foregroundStyle(CosmosTokens.secondary)
                            if let source = item.sourceURL, let url = URL(string: source) {
                                Link(Words.viewOnMaps, destination: url).font(.system(size: 12))
                            }
                        }
                        .textSelection(.enabled)
                        .frame(maxWidth: CosmosTokens.readingWidth, alignment: .leading)
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("Google Maps").font(.system(size: 11, weight: .semibold))
                    ForEach(Array(credits.enumerated()), id: \.offset) { credit in
                        creditLine(credit.element)
                    }
                }.foregroundStyle(CosmosTokens.secondary)
            case .choices(let title, let items):
                Text(title)
                    .font(.system(size: CosmosTokens.bodySize, weight: .semibold))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: CosmosTokens.readingWidth, alignment: .leading)
                    .accessibilityIdentifier("cosmos-choices-title")
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(items.enumerated()), id: \.offset) { entry in
                        choiceRow(entry.offset, entry.element, count: items.count)
                    }
                }
                .accessibilityIdentifier("cosmos-choices")
                Text(Words.chooseHint(items.count))
                    .font(.system(size: 11)).foregroundStyle(CosmosTokens.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Cosmos display")
    }

    /// One option: its number, its title and its detail. Clicking it, or pressing its
    /// number, sends that exact title back as the next request.
    private func choiceRow(_ index: Int, _ item: ChoiceItem, count: Int) -> some View {
        let isFocused = focused == index
        return Button { _ = pick?(index) } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("\(index + 1)")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(CosmosTokens.onAccent)
                    .frame(width: 18, height: 18)
                    .background(CosmosTokens.accent, in: Circle())
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title).font(.system(size: 14, weight: .semibold))
                    if !item.detail.isEmpty {
                        Text(item.detail).font(.system(size: 13)).foregroundStyle(CosmosTokens.secondary)
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .frame(maxWidth: CosmosTokens.readingWidth, alignment: .leading)
            .background(CosmosTokens.surface.opacity(isFocused ? 1 : 0.55),
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(isFocused ? CosmosTokens.accent : CosmosTokens.border,
                              lineWidth: isFocused ? 2 : 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .keyboardShortcut(index < 8
            ? KeyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
            : nil)
        .help("Send \"\(item.title)\" (⌘\(index + 1))")
        .accessibilityLabel("Option \(index + 1) of \(count): \(item.title). \(item.detail)")
        .accessibilityAddTraits(isFocused ? [.isSelected] : [])
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
