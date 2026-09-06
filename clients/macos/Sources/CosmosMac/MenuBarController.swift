import AppKit
import Combine
import SwiftUI

@MainActor
public final class MenuBarController: NSObject {
    public let model: ClientModel
    private let onQuit: @MainActor () -> Void
    private var statusItem: NSStatusItem?
    private var panel: NSPanel?
    private var shortcut: GlobalHotKey?
    private var subscription: AnyCancellable?
    private var windowObservers: [NSObjectProtocol] = []
    private let statusMenuItem = NSMenuItem(title: "Disconnected", action: nil, keyEquivalent: "")
    private let disconnectMenuItem = NSMenuItem(title: "Disconnect", action: nil, keyEquivalent: "")

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
        item.button?.image = NSImage(systemSymbolName: "sparkle", accessibilityDescription: "Cosmos")
        item.button?.toolTip = "Cosmos · public text"
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
        subscription = model.$snapshot.sink { [weak self] _ in
            Task { @MainActor [weak self] in self?.refreshMenu() }
        }
        refreshMenu()
        showPanel()
    }

    public func showPanel() {
        if panel == nil {
            let value = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 440, height: 700),
                styleMask: [.titled, .closable, .utilityWindow], backing: .buffered, defer: false)
            value.title = "Cosmos"
            value.isFloatingPanel = true
            value.hidesOnDeactivate = false
            value.isReleasedWhenClosed = false
            value.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
            value.contentView = NSHostingView(rootView: AssistantPanel(model: model))
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
    }

    /// The panel counts as a visible display only while it is on screen and not
    /// occluded or miniaturized. Reporting this is availability, never privacy evidence.
    private func reportVisibility(closing: Bool) {
        guard let panel else { model.setVisible(false); return }
        let visible = !closing && panel.isVisible && !panel.isMiniaturized
            && panel.occlusionState.contains(.visible)
        model.setVisible(visible)
    }

    /// Call on the main actor before releasing the controller during termination.
    public func stop() {
        shortcut?.stop()
        shortcut = nil
        subscription = nil
        for observer in windowObservers { NotificationCenter.default.removeObserver(observer) }
        windowObservers = []
        model.setVisible(false)
        model.stopPlayback()
        panel?.close()
        panel = nil
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
