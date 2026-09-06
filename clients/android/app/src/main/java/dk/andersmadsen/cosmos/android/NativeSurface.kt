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
    const val MAX_TEXT_BYTES = 4000

    /** create() returns an opaque nonzero handle or a status in -16..-1; handles may be negative. */
    fun isStatus(value: Long): Boolean = value in -16L..0L

    init {
        System.loadLibrary("cosmos_surface_client_ffi")
    }

    @JvmStatic external fun initialize(context: android.content.Context): Boolean
    @JvmStatic external fun create(config: ByteArray, callbacks: NativeCallbacks): Long
    @JvmStatic external fun connect(handle: Long): Int
    @JvmStatic external fun sendText(handle: Long, text: ByteArray): Int
    @JvmStatic external fun retryPending(handle: Long): Int
    @JvmStatic external fun cancel(handle: Long): Int
    @JvmStatic external fun setVisible(handle: Long, visible: Boolean): Int
    @JvmStatic external fun acknowledge(handle: Long): Int
    @JvmStatic external fun disconnect(handle: Long): Int
    @JvmStatic external fun poll(handle: Long): ByteArray?
    @JvmStatic external fun destroy(handle: Long): Int
}
