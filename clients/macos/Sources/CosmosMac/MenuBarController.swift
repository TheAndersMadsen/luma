import AppKit
import Combine
import SwiftUI

@MainActor
public final class MenuBarController: NSObject {
    public let model: ClientModel
    private let onQuit: @MainActor () -> Void
    private var statusItem: NSStatusItem?
    private var panel: NSPanel?
    private var hosting: NSHostingView<AssistantPanel>?
    private var shortcut: GlobalHotKey?
    private var subscriptions: [AnyCancellable] = []
    private var fitScheduled = false
    private var windowObservers: [NSObjectProtocol] = []
    private let statusMenuItem = NSMenuItem(title: "Disconnected", action: nil, keyEquivalent: "")
    private let disconnectMenuItem = NSMenuItem(title: "Disconnect", action: nil, keyEquivalent: "")
    /// The bridge records the origin only after a successful prepare, so its presence
    /// means this Mac was set up explicitly; later launches reopen that installation
    /// without another click. The first identity is still created only by the button.
    static let preparedOriginKey = "CosmosServerOrigin"

    public init(client: any ClientBridge,
                initialServerOrigin: String = "https://center.andersmadsen.dk",
                onQuit: @escaping @MainActor () -> Void) {
        model = ClientModel(client: client, initialServerOrigin: initialServerOrigin)
        self.onQuit = onQuit
        super.init()
    }

    public func start() {
        guard statusItem == nil else { showPanel(); return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = CosmosResources.menuBarIcon
        item.button?.imagePosition = .imageOnly
        item.button?.toolTip = "Cosmos · public text"
        item.button?.setAccessibilityLabel("Cosmos")
        let menu = NSMenu()
        menu.autoenablesItems = false
        let open = NSMenuItem(title: "Open Cosmos", action: #selector(openPanel), keyEquivalent: "")
        open.target = self
        menu.addItem(open)
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        menu.addItem(.separator())
        disconnectMenuItem.action = #selector(disconnect)
        disconnectMenuItem.target = self
        menu.addItem(disconnectMenuItem)
        let quit = NSMenuItem(title: "Quit Cosmos", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        statusItem = item

        let shortcut = GlobalHotKey { [weak self] in self?.showPanel() }
        self.shortcut = shortcut
        model.setShortcutMessage(shortcut.register()
            ? "Open this panel with \(GlobalHotKey.label)."
            : "The \(GlobalHotKey.label) shortcut is unavailable. Open Cosmos from the menu bar.")
        model.$snapshot.sink { [weak self] _ in
            Task { @MainActor [weak self] in self?.refreshMenu() }
        }.store(in: &subscriptions)
        // Any model change may change the panel's ideal height.
        model.objectWillChange.sink { [weak self] _ in
            Task { @MainActor [weak self] in self?.scheduleFit() }
        }.store(in: &subscriptions)
        refreshMenu()
        showPanel()
        if UserDefaults.standard.string(forKey: Self.preparedOriginKey) != nil { model.prepare() }
    }

    public func showPanel() {
        if panel == nil {
            let value = NSPanel(contentRect: NSRect(x: 0, y: 0, width: CosmosTokens.panelWidth, height: 420),
                styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
            value.title = "Cosmos"
            value.titleVisibility = .hidden
            value.titlebarAppearsTransparent = true
            value.titlebarSeparatorStyle = .none
            value.isMovableByWindowBackground = true
            value.standardWindowButton(.miniaturizeButton)?.isHidden = true
            value.standardWindowButton(.zoomButton)?.isHidden = true
            value.appearance = NSAppearance(named: .darkAqua)
            value.backgroundColor = CosmosTokens.backgroundNSColor
            value.isFloatingPanel = true
            value.hidesOnDeactivate = false
            value.isReleasedWhenClosed = false
            value.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
            let hosting = NSHostingView(rootView: AssistantPanel(model: model))
            value.contentView = hosting
            self.hosting = hosting
            fitPanel(animated: false)
            value.center()
            panel = value
            let center = NotificationCenter.default
            for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.willCloseNotification,
                         NSWindow.didBecomeKeyNotification, NSWindow.didMiniaturizeNotification,
                         NSWindow.didDeminiaturizeNotification] {
                windowObservers.append(center.addObserver(forName: name, object: value, queue: .main) { [weak self] note in
                    let closing = note.name == NSWindow.willCloseNotification
                    Task { @MainActor [weak self] in self?.reportVisibility(closing: closing) }
                })
            }
        }
        NSApp.activate()
        panel?.makeKeyAndOrderFront(nil)
        reportVisibility(closing: false)
        scheduleFit()
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
    private func fitPanel(animated: Bool) {
        guard let hosting else { return }
        let window = hosting.window ?? panel
        hosting.layoutSubtreeIfNeeded()
        // NSHostingView reports the SwiftUI ideal size as its intrinsic size.
        var ideal = hosting.intrinsicContentSize.height
        if ideal <= 0 || ideal == NSView.noIntrinsicMetric { ideal = hosting.fittingSize.height }
        let screen = window?.screen ?? NSScreen.main
        let cap = (screen?.visibleFrame.height ?? 900) * 0.85
        let height = min(max(ideal.rounded(.up), 280), cap)
        let content = NSSize(width: CosmosTokens.panelWidth, height: height)
        guard let window else { hosting.setFrameSize(content); return }
        var frame = window.frameRect(forContentRect: NSRect(origin: .zero, size: content))
        frame.origin.x = window.frame.origin.x
        frame.origin.y = window.frame.maxY - frame.height
        guard frame.size != window.frame.size else { return }
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        window.setFrame(frame, display: true, animate: animated && window.isVisible && !reduceMotion)
    }

    /// Call on the main actor before releasing the controller during termination.
    public func stop() {
        shortcut?.stop()
        shortcut = nil
        subscriptions = []
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
    }
    @objc private func openPanel() { showPanel() }
    @objc private func disconnect() { model.disconnect() }
    @objc private func quit() { onQuit() }
}
