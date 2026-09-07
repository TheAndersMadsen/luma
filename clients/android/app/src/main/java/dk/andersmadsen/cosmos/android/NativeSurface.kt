package dk.andersmadsen.cosmos.android

/**
 * Platform-owned key and protected journal. Called on the native worker thread;
 * implementations must be thread-safe, return promptly and never throw.
 */
interface NativeCallbacks {
    /** Exactly 65 uncompressed SEC1 P-256 bytes. */
    fun publicKey(): ByteArray
    /** Hash the complete message once with SHA-256 and return strict DER ECDSA. */
    fun signSha256(message: ByteArray): ByteArray
    /** The exact journal bytes, or null when no journal exists. */
    fun readJournal(): ByteArray?
    /** Durably and atomically replace the journal with these exact bytes. */
    fun writeJournalAtomically(bytes: ByteArray): Boolean
}

/** Thin JNI surface over the shared Rust client. Status codes follow cosmos_surface.h. */
object NativeSurface {
    const val OK = 0
    const val INVALID_ARGUMENT = -1
    const val QUEUE_FULL = -2
    const val CLOSED = -3
    const val PANIC = -4
    const val UNAVAILABLE = -5
    /** Kotlin-only: the loaded library predates an entry point, so the call was refused here and nothing was sent. */
    const val NOT_IN_THIS_BUILD = -100
    const val MAX_TEXT_BYTES = 4000
    const val MAX_SPEECH_BYTES = 1_048_576
    const val MAX_APP_BYTES = 64
    const val MAX_CONTEXT_BYTES = 8000

    /** create() returns an opaque nonzero handle or a status in -16..-1; handles may be negative. */
    fun isStatus(value: Long): Boolean = value in -16L..0L

    init {
        System.loadLibrary("cosmos_surface_client_ffi")
    }

    @JvmStatic external fun initialize(context: android.content.Context): Boolean
    @JvmStatic external fun create(config: ByteArray, callbacks: NativeCallbacks): Long
    @JvmStatic external fun connect(handle: Long): Int
    @JvmStatic external fun sendText(handle: Long, text: ByteArray): Int
    /** [target] is one of browser, macos, linux, android, android_tv, or empty to let Cosmos decide. */
    @JvmStatic external fun sendTextTo(handle: Long, text: ByteArray, target: ByteArray): Int
    /** Explicitly attached screen text: [app] at most 64 bytes, [context] at most 8000 bytes of UTF-8. */
    @JvmStatic external fun sendTextWithContext(handle: Long, text: ByteArray, app: ByteArray, context: ByteArray, target: ByteArray): Int

    /**
     * Runs a call to an entry point the loaded library may not have yet. A missing
     * symbol becomes [NOT_IN_THIS_BUILD] instead of an unhandled link error.
     */
    inline fun optional(call: () -> Int): Int = try { call() } catch (_: UnsatisfiedLinkError) { NOT_IN_THIS_BUILD }
    @JvmStatic external fun retryPending(handle: Long): Int
    @JvmStatic external fun cancel(handle: Long): Int
    @JvmStatic external fun setVisible(handle: Long, visible: Boolean): Int
    @JvmStatic external fun acknowledge(handle: Long): Int
    /** Only after the current spoken reply played to its end. */
    @JvmStatic external fun acknowledgeSpeech(handle: Long): Int
    /**
     * Bind the current command locally and say it is legal here. It claims
     * nothing about the effect, and it is never sent for a command this device
     * will not attempt.
     */
    @JvmStatic external fun acknowledgeTask(handle: Long): Int
    /**
     * Say what this device observed, once, as the bounded JSON of a report.
     * [actionId] is the command the report is about, exactly as the snapshot
     * spelled it. A report for anything but the current command is refused
     * with `stale_task` and closes nothing: a command the runtime replaced
     * between this device reading it and the worker sending is a different
     * command, and claiming its outcome would be a false outcome claim.
     */
    @JvmStatic external fun report(handle: Long, actionId: ByteArray, report: ByteArray): Int
    /** Say the current command is still running; it claims no outcome. */
    @JvmStatic external fun progress(handle: Long, sequence: Int, elapsedMs: Long): Int
    /** Answer the current ceremony with the actor evidence actually obtained. */
    @JvmStatic external fun grant(handle: Long, granted: Boolean, attestation: ByteArray): Int
    @JvmStatic external fun disconnect(handle: Long): Int
    @JvmStatic external fun poll(handle: Long): ByteArray?
    /** The current spoken reply's complete audio/mpeg bytes, or null when none is current. */
    @JvmStatic external fun speechAudio(handle: Long): ByteArray?
    /**
     * The exact bytes of the owner's own policy document for this installation,
     * or null when it holds none — an ordinary state that means it may do
     * nothing at all. The snapshot names this document's digest and length;
     * these are its bytes. It is a cache of one approval revision and is never
     * written to disk.
     */
    @JvmStatic external fun devicePolicy(handle: Long): ByteArray?
    @JvmStatic external fun destroy(handle: Long): Int
}
