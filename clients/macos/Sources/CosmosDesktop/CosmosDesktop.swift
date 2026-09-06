import AppKit
import CosmosMac
import Foundation

@main
struct CosmosDesktop {
    @MainActor
    static func main() {
        let application = NSApplication.shared
        let delegate = DesktopApplicationDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}

@MainActor
private final class DesktopApplicationDelegate: NSObject, NSApplicationDelegate {
    private var lease: InstallationLease?
    private var bridge: RustSurfaceBridge?
    private var menu: MenuBarController?
    private var terminationStarted = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        do {
            // Acquire process ownership before any user action can open Keychain.
            lease = try InstallationLease.acquire()
            let value = RustSurfaceBridge(epoch: try SystemBootEpoch.current())
            bridge = value
            let configured = UserDefaults.standard.string(forKey: "CosmosServerOrigin")
                ?? "https://center.andersmadsen.dk"
            let origin = (try? ServerEndpoint(configured))?.origin ?? "https://center.andersmadsen.dk"
            let controller = MenuBarController(client: value, initialServerOrigin: origin) {
                NSApp.terminate(nil)
            }
            menu = controller
            controller.start()
        } catch {
            let alert = NSAlert()
            alert.alertStyle = .warning
            if case DesktopPlatformError.alreadyRunning = error {
                alert.messageText = "Cosmos is already running"
                alert.informativeText = "Use the Cosmos menu-bar icon in the existing application."
            } else if case DesktopPlatformError.bootIdentifierUnavailable = error {
                alert.messageText = "Cosmos could not verify this Mac session"
                alert.informativeText = "The operating system boot identifier is unavailable. Close Cosmos and try again."
            } else {
                alert.messageText = "Cosmos could not open local storage"
                alert.informativeText = "The installation lock could not be opened safely. Close Cosmos and check this account’s Application Support permissions."
            }
            alert.addButton(withTitle: "Close")
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
            NSApp.terminate(nil)
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !terminationStarted else { return .terminateLater }
        guard let bridge else {
            lease = nil
            return .terminateNow
        }
        terminationStarted = true
        menu?.stop()
        Task {
            await bridge.shutdown()
            menu = nil
            self.bridge = nil
            // Native callbacks have finished; none can access this journal now.
            lease = nil
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}
