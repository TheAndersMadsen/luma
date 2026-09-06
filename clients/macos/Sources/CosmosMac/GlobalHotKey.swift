import Carbon
import Foundation

/// Registers exactly one combination. It never observes unrelated key events.
@MainActor
final class GlobalHotKey {
    static let label = "⌃⌥⌘Space"
    private static let signature: OSType = 0x43534d53
    private var hotKey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let activate: @MainActor () -> Void

    init(activate: @escaping @MainActor () -> Void) { self.activate = activate }

    func register() -> Bool {
        stop()
        var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let callback: EventHandlerUPP = { _, event, context in
            guard let event, let context else { return OSStatus(eventNotHandledErr) }
            var identifier = EventHotKeyID()
            let result = GetEventParameter(event, EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID), nil, numericCast(MemoryLayout<EventHotKeyID>.size), nil, &identifier)
            guard result == noErr, identifier.signature == 0x43534d53, identifier.id == 1 else {
                return OSStatus(eventNotHandledErr)
            }
            let owner = Unmanaged<GlobalHotKey>.fromOpaque(context).takeUnretainedValue()
            MainActor.assumeIsolated { owner.activate() }
            return noErr
        }
        let installed = InstallEventHandler(GetApplicationEventTarget(), callback, 1, &type,
            Unmanaged.passUnretained(self).toOpaque(), &handler)
        guard installed == noErr else { handler = nil; return false }
        let result = RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey | cmdKey),
            EventHotKeyID(signature: Self.signature, id: 1), GetApplicationEventTarget(),
            OptionBits(kEventHotKeyExclusive), &hotKey)
        guard result == noErr else { stop(); return false }
        return true
    }

    func stop() {
        if let hotKey { UnregisterEventHotKey(hotKey); self.hotKey = nil }
        if let handler { RemoveEventHandler(handler); self.handler = nil }
    }
}
