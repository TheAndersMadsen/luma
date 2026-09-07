import Foundation
import LocalAuthentication

/// What this Mac can prove about the person who answered, and the rule that
/// decides whether that is enough.
///
/// Cosmos declares `actor_unknown` for every installation: a tap proves someone
/// is at this keyboard, nothing more. A command that changes files therefore
/// needs device-owner authentication — Touch ID, the watch, or this account's
/// password — obtained here, at the machine that would carry it out. When none
/// can be obtained, nothing is spawned and the refusal says so plainly.
public enum ActorAttestation {
    /// The weakest evidence this Mac will act on for a command. A `mutates`
    /// entry is high risk by construction; nothing lowers it.
    public static func required(mutates: Bool) -> Attestation {
        mutates ? .deviceOwnerAuth : .foregroundTap
    }

    /// Whether evidence already obtained answers what a ceremony asked for.
    public static func satisfies(_ obtained: Attestation?, required: Attestation) -> Bool {
        guard let obtained else { return false }
        return obtained.strength >= required.strength
    }

    /// The check made immediately before a command is spawned: this Mac must
    /// already hold, for this exact action, evidence at least as strong as the
    /// entry itself demands. Anything weaker refuses before the process exists.
    public static func permitsRun(mutates: Bool, held: Attestation?) -> Bool {
        satisfies(held, required: required(mutates: mutates))
    }
}

/// Whether device-owner authentication can be asked for at all, and the result
/// when it is. Injected so the rule above is tested without a biometric prompt.
@MainActor
public protocol DeviceOwnerAuthenticating: AnyObject {
    /// Nil when this build can ask; otherwise one plain sentence saying why not.
    var unavailable: String? { get }
    /// True only when the person actually authenticated.
    func authenticate(reason: String) async -> Bool
}

/// `LAContext` over `.deviceOwnerAuthentication`: biometry, watch or this
/// account's password. It needs no entitlement and no usage string, but it does
/// need a code identity the system trusts. An ad-hoc development build has none,
/// and that reads as a sentence here rather than as a crash at the prompt.
@MainActor
public final class DeviceOwnerAuthenticator: DeviceOwnerAuthenticating {
    private let makeContext: @Sendable () -> LAContext

    public init(makeContext: @escaping @Sendable () -> LAContext = { LAContext() }) {
        self.makeContext = makeContext
    }

    public var unavailable: String? {
        let context = makeContext()
        var problem: NSError?
        guard !context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &problem) else { return nil }
        return Self.sentence(for: problem)
    }

    public func authenticate(reason: String) async -> Bool {
        let context = makeContext()
        context.localizedCancelTitle = Words.declineNoun
        var problem: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &problem) else { return false }
        return await withCheckedContinuation { continuation in
            context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, _ in
                continuation.resume(returning: success)
            }
        }
    }

    /// One sentence, in the owner's language, for each way the system can
    /// refuse to ask. Nothing technical reaches this line.
    nonisolated static func sentence(for problem: NSError?) -> String {
        guard let problem, problem.domain == LAErrorDomain,
              let code = LAError.Code(rawValue: problem.code) else {
            return Words.attestationUnavailable
        }
        switch code {
        case .passcodeNotSet, .biometryNotEnrolled, .biometryNotAvailable:
            return Words.attestationNotSetUp
        case .invalidContext, .notInteractive:
            return Words.attestationUnsignedBuild
        default:
            return Words.attestationUnavailable
        }
    }
}
