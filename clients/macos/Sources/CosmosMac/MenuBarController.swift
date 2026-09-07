import AppKit
import Combine
import SwiftUI

/// The window the panel lives in: borderless, rounded, with the system's own
/// material behind it. Escape hides it — hiding is not cancelling the turn — and
/// Command-period asks the model to cancel the task instead.
@MainActor
final class CosmosPanelWindow: NSPanel {
    var onEscape: (@MainActor () -> Void)?
    var onCancelTask: (@MainActor () -> Void)?
    /// This application has no main menu, so SwiftUI's own keyboard shortcuts never
    /// reach the panel. Every Command combination the panel offers is handled here.
    var onKeyEquivalent: (@MainActor (NSEvent) -> Bool)?

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if MainActor.assumeIsolated({ onKeyEquivalent?(event) }) == true { return true }
        return super.performKeyEquivalent(with: event)
    }

    /// AppKit routes both Escape and Command-period here. Only the second one is a
    /// request to cancel the task; a bare Escape closes the panel and nothing else.
    override func cancelOperation(_ sender: Any?) {
        if NSApp.currentEvent?.modifierFlags.contains(.command) == true {
            onCancelTask?()
        } else {
            onEscape?()
        }
    }
}

@MainActor
public final class MenuBarController: NSObject {
    public let model: ClientModel
    private let onQuit: @MainActor () -> Void
    private var statusItem: NSStatusItem?
    private var panel: CosmosPanelWindow?
    private var hosting: NSHostingView<AssistantPanel>?
    private var shortcut: GlobalHotKey?
    private var subscriptions: [AnyCancellable] = []
    private var fitScheduled = false
    private var windowObservers: [NSObjectProtocol] = []
    private var presence: MenuPresence = .quiet
    private let commands = PanelCommands()
    private let menu = NSMenu()
    private let statusMenuItem = NSMenuItem(title: Words.disconnected, action: nil, keyEquivalent: "")
    private let disconnectMenuItem = NSMenuItem(title: Words.disconnect, action: nil, keyEquivalent: "")
    private let autoPresentMenuItem = NSMenuItem(title: Words.showRepliesAutomatically,
                                                 action: nil, keyEquivalent: "")
    /// The owner's own switch for always-listening: one item, off until they
    /// turn it on, remembered from then on.
    private let listenMenuItem = NSMenuItem(title: Words.listenForPhrase,
                                            action: nil, keyEquivalent: "")
    /// The bridge records the origin only after a successful prepare, so its presence
    /// means this Mac was set up explicitly; later launches reopen that installation
    /// without another click. The first identity is still created only by the button.
    static let preparedOriginKey = "CosmosServerOrigin"
    /// The owner's own switch for replies that show themselves, remembered across
    /// launches. Absent means on: a reply presenting itself is the default.
    static let autoPresentKey = "CosmosShowRepliesAutomatically"

    // MARK: A reply that shows itself

    /// How the panel came to be on screen right now, or nil while it is hidden.
    private var opening: AutoPresent.Opening?
    /// Everything currently delivered here that has already been acted on, so one
    /// reply presents itself once and a retired one is forgotten.
    private var handled: Set<UUID> = []
    /// The moment an unattended panel may start fading, renewed by any attention.
    private var dwellUntil: Date?
    private var dwell: Task<Void, Never>?
    /// Bumped by each fade so a panel reopened mid-fade is never ordered out.
    private var fadeGeneration: UInt64 = 0
    /// True only while the panel is on its way out. Attention during those few
    /// hundred milliseconds brings it back rather than letting it finish leaving.
    private var fading = false
    /// Whether this Mac was recording a spoken request the last time anything
    /// changed, so the panel comes up once at the start of one and not on every
    /// model change during it.
    private var wasCapturing = false
    private var eventMonitor: Any?

    public init(client: any ClientBridge,
                initialServerOrigin: String = "https://center.andersmadsen.dk",
                onQuit: @escaping @MainActor () -> Void) {
        model = ClientModel(client: client, initialServerOrigin: initialServerOrigin,
                            listener: ClientModel.systemListener())
        self.onQuit = onQuit
        super.init()
    }

    public func start() {
        guard statusItem == nil else { showPanel(); return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = CosmosResources.menuBarIcon(.quiet)
        item.button?.imagePosition = .imageOnly
        item.button?.toolTip = MenuPresence.quiet.help
        item.button?.setAccessibilityLabel(Words.appName)
        item.button?.target = self
        item.button?.action = #selector(statusItemClicked)
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        buildMenu()
        installEditingMenu()
        statusItem = item

        let shortcut = GlobalHotKey { [weak self] in self?.togglePanel() }
        self.shortcut = shortcut
        model.setShortcutMessage(shortcut.register()
            ? "Open this panel with \(GlobalHotKey.label)."
            : "The \(GlobalHotKey.label) shortcut is unavailable. Open Cosmos from the menu bar.")
        model.$snapshot.sink { [weak self] _ in
            Task { @MainActor [weak self] in self?.refreshMenu() }
        }.store(in: &subscriptions)
        // Any model change may change the panel's ideal height or its presence,
        // and it is where a newly delivered reply is noticed.
        model.objectWillChange.sink { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.scheduleFit()
                self?.refreshPresence()
                self?.considerListening()
                self?.considerPresenting()
            }
        }.store(in: &subscriptions)
        watchForAttention()
        refreshMenu()
        // Build the window now so the first open draws the current state rather than
        // an empty frame, but only show it when this Mac has never been set up.
        let firstRun = UserDefaults.standard.string(forKey: Self.preparedOriginKey) == nil
        makePanel()
        if firstRun {
            showPanel()
        } else {
            model.prepare()
            // The owner's own switch, back where they left it. On a first run
            // nothing opens a microphone: the switch does not exist yet.
            model.resumeListening()
        }
    }

    private func buildMenu() {
        menu.removeAllItems()
        menu.autoenablesItems = false
        let open = NSMenuItem(title: Words.openCosmos, action: #selector(openPanel), keyEquivalent: "")
        open.target = self
        menu.addItem(open)
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())
        // The same explicit capture the panel offers; the shortcut also works from
        // the panel's own button while it is the key window.
        let useSelection = NSMenuItem(title: "Use Selected Text", action: #selector(useSelectedText), keyEquivalent: "U")
        useSelection.keyEquivalentModifierMask = [.command, .shift]
        useSelection.target = self
        menu.addItem(useSelection)
        autoPresentMenuItem.action = #selector(toggleAutoPresent)
        autoPresentMenuItem.target = self
        autoPresentMenuItem.state = Self.autoPresentEnabled ? .on : .off
        menu.addItem(autoPresentMenuItem)
        listenMenuItem.action = #selector(toggleListening)
        listenMenuItem.target = self
        listenMenuItem.state = model.listening.isOn ? .on : .off
        listenMenuItem.toolTip = "\(Words.listeningStaysHere) \(Words.listeningIsVisible) "
            + Words.listeningEndsWithTheLid
        menu.addItem(listenMenuItem)
        menu.addItem(.separator())
        disconnectMenuItem.action = #selector(disconnect)
        disconnectMenuItem.target = self
        menu.addItem(disconnectMenuItem)
        let quit = NSMenuItem(title: Words.quit, action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    /// An accessory application shows no menu bar, but AppKit still resolves the
    /// standard editing shortcuts through the main menu. Without one the ask field
    /// has no Cut, Copy, Paste, Undo or Select All, and Command-Q does nothing.
    /// This menu is never displayed; it exists so the keyboard works.
    private func installEditingMenu() {
        let main = NSMenu()
        let application = NSMenuItem()
        let applicationMenu = NSMenu()
        let quitItem = NSMenuItem(title: Words.quit, action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        applicationMenu.addItem(quitItem)
        application.submenu = applicationMenu
        main.addItem(application)

        let editing = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        let redo = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        for item in [NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"), redo,
                     .separator(),
                     NSMenuItem(title: "Cut", action: Selector(("cut:")), keyEquivalent: "x"),
                     NSMenuItem(title: "Copy", action: Selector(("copy:")), keyEquivalent: "c"),
                     NSMenuItem(title: "Paste", action: Selector(("paste:")), keyEquivalent: "v"),
                     NSMenuItem(title: "Select All", action: Selector(("selectAll:")), keyEquivalent: "a")] {
            edit.addItem(item)
        }
        editing.submenu = edit
        main.addItem(editing)
        NSApp.mainMenu = main
    }

    /// Builds the window once and keeps it. Reopening it never redraws from nothing:
    /// the panel is already showing the state it had when it was hidden.
    private func makePanel() {
        guard panel == nil else { return }
        // A non-activating panel can appear over the application the owner is
        // using without taking the keyboard or bringing Cosmos forward. The
        // owner's own open still activates deliberately.
        let window = CosmosPanelWindow(contentRect: NSRect(x: 0, y: 0, width: CosmosTokens.panelWidth, height: 360),
                                       styleMask: [.borderless, .fullSizeContentView, .nonactivatingPanel],
                                       backing: .buffered, defer: false)
        window.title = Words.appName
        window.isMovableByWindowBackground = true
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.isFloatingPanel = true
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.onEscape = { [weak self] in self?.hidePanel() }
        window.onCancelTask = { [weak self] in self?.cancelTask() }
        window.onKeyEquivalent = { [weak self] event in self?.handleKeyEquivalent(event) ?? false }
        let hosting = NSHostingView(rootView: AssistantPanel(model: model, commands: commands,
                                                             onClose: { [weak self] in self?.hidePanel() }))
        hosting.wantsLayer = true
        hosting.layer?.cornerRadius = CosmosTokens.windowRadius
        hosting.layer?.cornerCurve = .continuous
        hosting.layer?.masksToBounds = true
        window.contentView = hosting
        self.hosting = hosting
        panel = window
        fitPanel(animated: false)
        positionPanel()
        let center = NotificationCenter.default
        for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.willCloseNotification,
                     NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification,
                     NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification] {
            windowObservers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] note in
                let closing = note.name == NSWindow.willCloseNotification
                let key = note.name == NSWindow.didBecomeKeyNotification
                    ? true : (note.name == NSWindow.didResignKeyNotification ? false : nil)
                Task { @MainActor [weak self] in
                    self?.reportVisibility(closing: closing)
                    if let key { self?.commands.windowIsKey = key }
                }
            })
        }
    }

    public func showPanel() {
        makePanel()
        positionPanel()
        // The owner asked for this panel, so it is theirs: no countdown runs
        // over it and nothing takes it away again.
        opening = .owner
        stopDwell()
        cancelFade()
        // An accessory application is not brought forward by a plain activate() when
        // another application is in front; the panel would appear without the keyboard.
        // Ordering it front first and taking key again on the next turn of the run
        // loop is what makes the panel typable the instant it appears.
        panel?.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        panel?.makeKeyAndOrderFront(nil)
        DispatchQueue.main.async { [weak self] in
            guard let panel = self?.panel, panel.isVisible, !panel.isKeyWindow else { return }
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKey()
        }
        commands.focusAsk()
        reportVisibility(closing: false)
        scheduleFit()
    }

    /// Hiding the panel is not cancelling the task: the turn continues and the
    /// menu-bar glyph keeps reporting it.
    public func hidePanel() {
        stopDwell()
        cancelFade()
        opening = nil
        panel?.orderOut(nil)
        reportVisibility(closing: true)
    }

    private func togglePanel() {
        if panel?.isVisible == true, panel?.isKeyWindow == true { hidePanel() } else { showPanel() }
    }

    /// Under the menu-bar item, clear of the screen edges. Without a reachable item
    /// (a full-screen app hides the menu bar) the panel opens centred instead.
    private func positionPanel() {
        guard let panel else { return }
        let size = panel.frame.size
        guard let screen = anchorScreen() else { return }
        let visible = screen.visibleFrame
        var origin: NSPoint
        // The menu bar sits above the visible frame, so the anchor is checked against
        // the whole screen; a full-screen app that hides the bar falls back to centred.
        if let anchor = anchorFrame(), screen.frame.intersects(anchor) {
            origin = NSPoint(x: anchor.midX - size.width / 2, y: anchor.minY - 8 - size.height)
        } else {
            origin = NSPoint(x: visible.midX - size.width / 2,
                             y: visible.maxY - size.height - visible.height * 0.12)
        }
        origin.x = min(max(origin.x, visible.minX + 8), visible.maxX - size.width - 8)
        origin.y = min(max(origin.y, visible.minY + 8), visible.maxY - size.height - 8)
        panel.setFrameOrigin(origin)
    }

    private func anchorFrame() -> NSRect? {
        guard let button = statusItem?.button, let window = button.window else { return nil }
        return window.convertToScreen(button.convert(button.bounds, to: nil))
    }

    private func anchorScreen() -> NSScreen? {
        if let anchor = anchorFrame(), let screen = NSScreen.screens.first(where: { $0.frame.intersects(anchor) }) {
            return screen
        }
        return panel?.screen ?? NSScreen.main
    }

    // MARK: A reply that shows itself

    /// The owner's own switch, remembered across launches. Absent means on: a
    /// reply arriving here presents itself unless the owner said otherwise.
    static var autoPresentEnabled: Bool {
        UserDefaults.standard.object(forKey: autoPresentKey) as? Bool ?? true
    }

    /// What the operating system can honestly say about the room the panel would
    /// appear in. Read only when something has actually arrived.
    private func room() -> AutoPresent.Room {
        let anchor = anchorFrame().flatMap { frame in
            NSScreen.screens.first { $0.frame.intersects(frame) }
        }
        return AutoPresent.Room(
            enabled: Self.autoPresentEnabled,
            screenLocked: SystemPresence.screenLocked,
            focusOn: SystemPresence.focusOn,
            fullScreen: anchor.map(SystemPresence.fullScreen(on:)) ?? false,
            anchored: anchor != nil
        )
    }

    /// A reply delivered to this Mac presents itself. This runs on every model
    /// change and acts only the first time each delivery is seen.
    private func considerPresenting() {
        let current = AutoPresent.arrivals(display: model.display, speech: model.speech,
                                           confirmation: model.snapshot.confirmation,
                                           task: model.snapshot.task)
        // Anything Cosmos retired is forgotten, so this remembers only what is
        // current and a later delivery of the same kind still presents itself.
        handled.formIntersection(Set(current.map(\.id)))
        guard let arrival = current.first(where: { !handled.contains($0.id) }) else { return }
        handled.insert(arrival.id)
        let showing = panel?.isVisible == true
        switch AutoPresent.decide(arrival, room: room(), showing: showing, opening: opening) {
        case .hold:
            // The glyph already says something is waiting, and the reply is
            // there the moment the owner opens Cosmos.
            return
        case .present, .stay:
            // Something new arrived: a panel halfway out comes back rather than
            // taking the reply with it.
            cancelFade()
            if !showing { presentAutomatically() }
            // A panel the owner opened themselves keeps no countdown.
            guard opening == .automatic else { return }
            startDwell()
        }
    }

    /// The phrase fired. The panel comes up so the owner can see that this Mac
    /// is recording them, and it stays up for as long as it is: an indicator
    /// that can fade away mid-request is not an indicator.
    private func considerListening() {
        let capturing = model.capturingRequest
        guard capturing != wasCapturing else { return }
        wasCapturing = capturing
        guard capturing else {
            // The capture is over; a panel that came up only for it may leave
            // again once whatever answers it has been read.
            if opening == .automatic { startDwell() }
            return
        }
        cancelFade()
        stopDwell()
        if panel?.isVisible != true { presentAutomatically() }
    }

    /// The panel appears under the menu-bar item without taking the keyboard:
    /// the owner keeps typing wherever they were and Cosmos never comes forward.
    /// It fades in rather than snapping into place.
    private func presentAutomatically() {
        makePanel()
        guard let panel else { return }
        cancelFade()
        opening = .automatic
        fitPanel(animated: false)
        positionPanel()
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        panel.alphaValue = reduceMotion ? 1 : 0
        panel.orderFrontRegardless()
        if !reduceMotion {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = CosmosTokens.motionDuration
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().alphaValue = 1
            }
        }
        reportVisibility(closing: false)
        scheduleFit()
    }

    /// It leaves the way it came: a short fade, not a disappearance.
    private func fadeAway() {
        stopDwell()
        guard let panel, panel.isVisible else { return }
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { hidePanel(); return }
        fadeGeneration &+= 1
        fading = true
        let generation = fadeGeneration
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = AutoPresent.fadeSeconds
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 0
        }, completionHandler: {
            MainActor.assumeIsolated { [weak self] in
                guard let self, generation == fadeGeneration else { return }
                fading = false
                panel.orderOut(nil)
                panel.alphaValue = 1
                opening = nil
                reportVisibility(closing: true)
            }
        })
    }

    /// Stops a fade in progress and brings the panel back to full opacity, so a
    /// panel reopened mid-fade is never ordered out behind the owner's back.
    private func cancelFade() {
        fadeGeneration &+= 1
        fading = false
        guard let panel else { return }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0
            panel.animator().alphaValue = 1
        }
        panel.alphaValue = 1
    }

    /// The countdown an unattended panel runs. It ticks rather than sleeping
    /// once, because attention renews it and the content it times can change.
    private func startDwell() {
        renewDwell()
        guard dwell == nil else { return }
        dwell = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard !Task.isCancelled, let self else { return }
                tickDwell()
            }
        }
    }

    private func stopDwell() {
        dwell?.cancel()
        dwell = nil
        dwellUntil = nil
    }

    /// The panel has this long left, counted from now. Every sign of attention
    /// calls this again, so the countdown starts over when attention ends.
    private func renewDwell() {
        let text = AutoPresent.readable(card: model.display, speech: model.speech, task: model.taskCard)
        dwellUntil = Date().addingTimeInterval(AutoPresent.dwell(for: text))
    }

    private func tickDwell() {
        guard opening == .automatic, let panel, panel.isVisible else { stopDwell(); return }
        let pointerInside = panel.frame.contains(NSEvent.mouseLocation)
        guard !AutoPresent.holdsOpen(pointerInside: pointerInside, windowIsKey: panel.isKeyWindow,
                                     drafting: !model.draft.isEmpty, choosing: commands.destinationsShown,
                                     playing: model.speaking, workingHere: model.canCancelTask,
                                     ceremony: model.ceremony != nil) else {
            renewDwell()
            return
        }
        guard let deadline = dwellUntil, Date() >= deadline else { return }
        fadeAway()
    }

    /// A keystroke while the panel takes keys, a scroll over the card, or a
    /// click on it: each is the owner attending to the reply, and each starts
    /// the countdown over. A click also hands the panel the keyboard, because a
    /// panel the owner reached for has to be typable.
    private func watchForAttention() {
        guard eventMonitor == nil else { return }
        eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .scrollWheel, .leftMouseDown]) { event in
            let click = event.type == .leftMouseDown
            MainActor.assumeIsolated { [weak self] in self?.noticedAttention(click: click) }
            return event
        }
    }

    private func noticedAttention(click: Bool) {
        guard opening == .automatic, let panel, panel.isVisible else { return }
        // Attention during the fade itself brings the panel back; the owner
        // reached for it, so it is not leaving after all.
        if fading {
            cancelFade()
            startDwell()
        }
        if click, panel.frame.contains(NSEvent.mouseLocation), !NSApp.isActive {
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKey()
        }
        renewDwell()
    }

    /// Every Command combination the panel promises, resolved by one pure mapping
    /// and applied here. Anything unclaimed falls through to the text field.
    private func handleKeyEquivalent(_ event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        guard let key = event.charactersIgnoringModifiers,
              let command = PanelState.command(key: key, command: flags.contains(.command),
                                               shift: flags.contains(.shift),
                                               option: flags.contains(.option),
                                               control: flags.contains(.control),
                                               choiceCount: model.choiceCount,
                                               ceremony: model.ceremony != nil) else { return false }
        switch command {
        case .send:
            guard model.canSend else { return false }
            model.send()
        case .confirmTask:
            guard model.ceremony?.canConfirm == true else { return false }
            model.answerCeremony(granted: true)
        case .declineTask:
            guard model.ceremony != nil else { return false }
            model.answerCeremony(granted: false)
        case .cancelTask:
            cancelTask()
        case .destinations:
            commands.destinationsShown.toggle()
        case .close:
            hidePanel()
        case .focusAsk:
            commands.focusAsk()
        case .useSelection:
            model.useSelection()
        case .choose(let index):
            return model.choose(index)
        }
        return true
    }

    /// Command-period stops the command running on this Mac when there is one.
    /// Otherwise it is the turn's own cancel, and with neither it closes the
    /// panel — which is not cancelling anything.
    private func cancelTask() {
        if model.canCancelTask {
            model.cancelTask()
        } else if model.canCancel {
            model.cancel()
        } else {
            hidePanel()
        }
    }

    /// The panel counts as a visible display only while it is on screen and not
    /// occluded or miniaturized. Reporting this is availability, never privacy evidence.
    private func reportVisibility(closing: Bool) {
        guard let panel else { model.setVisible(false); return }
        let visible = !closing && panel.isVisible && !panel.isMiniaturized
            && panel.occlusionState.contains(.visible)
        model.setVisible(visible)
    }

    private func scheduleFit() {
        guard !fitScheduled else { return }
        fitScheduled = true
        // Let SwiftUI apply the change before measuring the new ideal height.
        DispatchQueue.main.async { [weak self] in
            self?.fitScheduled = false
            self?.fitPanel(animated: true)
        }
    }

    /// The panel keeps the kit width and follows its content's ideal height, capped
    /// to the screen; longer content scrolls inside while the ask field stays pinned.
    /// The height eases into place instead of jumping, unless motion is reduced.
    private func fitPanel(animated: Bool) {
        guard let hosting else { return }
        let window = hosting.window ?? panel
        hosting.layoutSubtreeIfNeeded()
        // NSHostingView reports the SwiftUI ideal size as its intrinsic size.
        var ideal = hosting.intrinsicContentSize.height
        if ideal <= 0 || ideal == NSView.noIntrinsicMetric { ideal = hosting.fittingSize.height }
        let screen = window?.screen ?? anchorScreen()
        let cap = (screen?.visibleFrame.height ?? 900) * 0.8
        let height = min(max(ideal.rounded(.up), 220), cap)
        let content = NSSize(width: CosmosTokens.panelWidth, height: height)
        guard let window else { hosting.setFrameSize(content); return }
        var frame = window.frameRect(forContentRect: NSRect(origin: .zero, size: content))
        frame.origin.x = window.frame.origin.x
        frame.origin.y = window.frame.maxY - frame.height
        guard frame.size != window.frame.size else { return }
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        guard animated, window.isVisible, !reduceMotion else {
            window.setFrame(frame, display: true)
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = CosmosTokens.motionDuration
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            window.animator().setFrame(frame, display: true)
        }
    }

    /// Call on the main actor before releasing the controller during termination.
    public func stop() {
        // The microphone closes before anything else does.
        model.suspendListening()
        shortcut?.stop()
        shortcut = nil
        subscriptions = []
        stopDwell()
        if let eventMonitor { NSEvent.removeMonitor(eventMonitor) }
        eventMonitor = nil
        opening = nil
        for observer in windowObservers { NotificationCenter.default.removeObserver(observer) }
        windowObservers = []
        model.setVisible(false)
        model.stopPlayback()
        panel?.close()
        panel = nil
        hosting = nil
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        statusItem = nil
    }

    private func refreshMenu() {
        statusMenuItem.title = model.statusText
        disconnectMenuItem.isEnabled = model.canDisconnect
        listenMenuItem.state = model.listening.isOn ? .on : .off
    }

    /// Presence is the icon and nothing else: quiet, working, waiting for you.
    private func refreshPresence() {
        let value = model.presence
        guard value != presence else { return }
        presence = value
        statusItem?.button?.image = CosmosResources.menuBarIcon(value)
        statusItem?.button?.toolTip = value.help
    }

    @objc private func statusItemClicked() {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true {
            statusItem?.menu = menu
            statusItem?.button?.performClick(nil)
            statusItem?.menu = nil
        } else {
            togglePanel()
        }
    }
    @objc private func openPanel() { showPanel() }
    @objc private func useSelectedText() {
        model.useSelection()
        showPanel()
    }
    /// Turning it off stops the next reply from showing itself and takes down the
    /// one on screen now, which is what the owner just asked for.
    /// Turning it on asks for the microphone then and there, and opens the
    /// panel so the owner reads what listening on a laptop actually means
    /// beside the indicator that says it started. Turning it off stops the
    /// audio stream itself.
    @objc private func toggleListening() {
        model.toggleListening()
        listenMenuItem.state = model.listening.isOn ? .on : .off
        if model.listening.isOn { showPanel() }
    }

    @objc private func toggleAutoPresent() {
        let enabled = !Self.autoPresentEnabled
        UserDefaults.standard.set(enabled, forKey: Self.autoPresentKey)
        autoPresentMenuItem.state = enabled ? .on : .off
        if !enabled, opening == .automatic { fadeAway() }
    }
    @objc private func disconnect() { model.disconnect() }
    @objc private func quit() { onQuit() }
}
