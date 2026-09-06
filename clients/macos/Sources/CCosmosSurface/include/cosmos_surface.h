#ifndef COSMOS_SURFACE_H
#define COSMOS_SURFACE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct CosmosSurface CosmosSurface;

enum {
    COSMOS_SURFACE_OK = 0,
    COSMOS_SURFACE_EMPTY = 1,
    COSMOS_SURFACE_BUFFER_TOO_SMALL = 2,
    COSMOS_SURFACE_INVALID_ARGUMENT = -1,
    COSMOS_SURFACE_QUEUE_FULL = -2,
    COSMOS_SURFACE_CLOSED = -3,
    COSMOS_SURFACE_PANIC = -4,
    COSMOS_SURFACE_UNAVAILABLE = -5,
    COSMOS_SURFACE_CALLBACK_NOT_FOUND = 1,
    COSMOS_SURFACE_MAX_CONFIG_BYTES = 2048,
    COSMOS_SURFACE_MAX_TEXT_BYTES = 4000,
    COSMOS_SURFACE_MAX_JOURNAL_BYTES = 32768,
    COSMOS_SURFACE_MAX_EVENT_BYTES = 16384,
    COSMOS_SURFACE_MAX_SPEECH_BYTES = 1048576
};

/* All callback buffers belong to Rust and are borrowed only for the call.
 * Return 0 on success; set *written to the exact initialized byte count.
 * read_journal alone may return CALLBACK_NOT_FOUND with *written = 0.
 * public_key returns exactly 65 uncompressed SEC1 P-256 bytes.
 * sign_sha256 hashes the supplied message once with SHA256 and returns a DER
 * ECDSA signature, at most 72 bytes. Do not prehash the message twice.
 * Journals contain credentials and possibly pending user text. Read/write only
 * protected storage; a successful write must be atomic and durable. A journal
 * is always nonempty; zero length does not mean delete.
 * The callbacks and context are copied, then used synchronously on one owned
 * worker thread. They must be thread-safe, return promptly, never throw/unwind
 * through C, and never reenter this API. They must not synchronously wait on
 * the main thread: that thread may be waiting for this callback during destroy.
 * No pointer may be retained. */
typedef int32_t (*CosmosSurfaceRead)(void *context, uint8_t *output,
                                   size_t capacity, size_t *written);
typedef int32_t (*CosmosSurfaceSign)(void *context, const uint8_t *message,
                                   size_t message_length, uint8_t *output,
                                   size_t capacity, size_t *written);
typedef int32_t (*CosmosSurfaceWrite)(void *context, const uint8_t *journal,
                                    size_t journal_length);

typedef struct CosmosSurfaceCallbacks {
    void *context;
    CosmosSurfaceRead public_key;
    CosmosSurfaceSign sign_sha256;
    CosmosSurfaceRead read_journal;
    CosmosSurfaceWrite write_journal_atomically;
} CosmosSurfaceCallbacks;

/* Config is strict UTF-8 JSON, with exactly:
 * {"version":1,"serverOrigin":"https://center.example",
 *  "enrollmentId":"UUID","platform":"macos","bootEpoch":"UUID"}
 * Platform is macos, linux, android, or android_tv. A boot epoch identifies the
 * actual host boot, not a launch. Hold exclusive journal ownership externally.
 * Create only validates the public arguments and starts the worker. Poll the
 * prepare event for key/journal validation and the public enrollment descriptor.
 * Retain context before create: callbacks can start before it returns. With
 * a valid output pointer, every non-OK return sets *output=NULL and leaves no
 * worker using callbacks. All input bytes are copied before return.
 * All non-destroy handle functions
 * can be called concurrently. Enqueue success is not execution or admission. */
/* One client or callback-free cleanup tail is allowed per process. Create
 * returns QUEUE_FULL while either holds the slot; retry only when the prior
 * cleanup has finished. This limit also applies across journal/server choices. */
int32_t cosmos_surface_create(const uint8_t *config, size_t config_length,
                             const CosmosSurfaceCallbacks *callbacks,
                             CosmosSurface **output);
int32_t cosmos_surface_connect(CosmosSurface *surface);
int32_t cosmos_surface_send_text(CosmosSurface *surface, const uint8_t *text,
                                size_t text_length);
int32_t cosmos_surface_retry_pending(CosmosSurface *surface);
int32_t cosmos_surface_cancel(CosmosSurface *surface);
/* Report the platform's own foreground visibility (0 or 1). Cosmos treats a
 * visible installation as available for one shared-room visual card; it is
 * never occupancy, privacy or actor evidence. The last value is re-reported
 * after every new connection. */
int32_t cosmos_surface_set_visible(CosmosSurface *surface, int32_t visible);
/* Acknowledge the current "display" card only after the platform committed
 * its complete, exact render including every credit line. Acknowledging a
 * card that was not fully shown is a false outcome claim. */
int32_t cosmos_surface_acknowledge(CosmosSurface *surface);
/* Acknowledge the current "speech" reply only after the platform played its
 * complete audio to the end. Acknowledging interrupted or unplayed audio is a
 * false outcome claim. */
int32_t cosmos_surface_acknowledge_speech(CosmosSurface *surface);
/* Copy the current spoken reply's complete audio bytes (the snapshot's
 * speech.byteLength). EMPTY when no reply is current; BUFFER_TOO_SMALL sets
 * *written to the required size. Bytes are audio/mpeg. */
int32_t cosmos_surface_speech_audio(CosmosSurface *surface, uint8_t *output,
                                   size_t capacity, size_t *written);
int32_t cosmos_surface_disconnect(CosmosSurface *surface);

/* Nonblocking safe JSON snapshot, UTF-8 bytes without a trailing NUL:
 * {version:1,kind:"state",operation:"prepare|connect|send_text|retry_pending|
 * cancel|set_visible|acknowledge|acknowledge_speech|display|speech|disconnect|
 * heartbeat",
 * outcome:"ok|error",error:null|STATIC_CODE,
 * connected:bool,pendingOpen:bool,needsReconnect:bool,
 * descriptor:null|PUBLIC_DESCRIPTOR,
 * pending:null|{kind:"text|heartbeat|cancel|state|acknowledge",instanceId:UUID,
 * sequence:integer,canRetry:bool},
 * lastUnknown:null|SAME_PENDING_SHAPE,
 * admission:null|{turnId:UUID,generation:integer,duplicate:bool},
 * visible:bool,
 * display:null|{actionId:UUID,turnId:UUID,generation:integer,
 * contentDigest:HEX64,expiresAtMs:integer,
 * content:{kind:"text",text:STRING}|{kind:"places",query:STRING,
 * items:[{placeId,name,address,sourceUrl:null|HTTPS}],attributions:[STRING]},
 * credits:[[{kind:"text",text}|{kind:"link",text,href:HTTPS}]]},
 * speech:null|{actionId:UUID,turnId:UUID,generation:integer,contentDigest:HEX64,
 * expiresAtMs:integer,text:STRING,format:"audio/mpeg",byteLength:integer},
 * eventsSkipped:N}
 * A "speech" operation reports a complete or retired spoken reply; fetch its
 * bytes with cosmos_surface_speech_audio and acknowledge after full playback.
 * credits holds one inert token list per attribution string, in order; render
 * every token verbatim as text or one HTTPS link, never as markup.
 * A "display" operation reports a delivered or retired card; the client has
 * already verified its digest, connection binding and credit grammar.
 * pendingOpen requires explicit connect to recover the saved signed open.
 * RPC retry requires pending.canRetry; needsReconnect requires connect first.
 * Snapshots contain no journal, session token, signature, request text, or remote
 * error message. "admission" proves input admission only, never output/render.
 * At most 64 snapshots are retained; a full queue replaces its oldest snapshot.
 * Every snapshot is complete, and eventsSkipped reports cumulative replacements.
 * Empty returns EMPTY and *written=0. A short buffer returns BUFFER_TOO_SMALL,
 * sets *written to required size, and does not consume the event. A concurrent
 * poll or queue overflow can still replace it; use MAX_EVENT_BYTES capacity.
 * output may be NULL only with capacity=0; written must always be valid. */
int32_t cosmos_surface_poll(CosmosSurface *surface, uint8_t *output,
                           size_t capacity, size_t *written);

/* Exclusively destroy a live handle exactly once. No other API call may run
 * concurrently with destroy. Stops queued commands, interrupts in-flight async
 * work, attempts bounded disconnect, and waits for every key/journal callback
 * to finish before returning. The worker may then continue network cleanup
 * without callback access. Its process slot remains occupied until cleanup
 * finishes, preventing another create from accumulating unfinished SDK work.
 * The callback context must remain valid until this returns. No callbacks occur
 * afterward, including when it returns PANIC. Never invoke from a callback.
 * Keep this library loaded for the application lifetime; network cleanup may
 * continue after destroy. An SDK cleanup failure may require an app restart.
 * NULL is accepted as a no-op. */
int32_t cosmos_surface_destroy(CosmosSurface *surface);

#ifdef __cplusplus
}
#endif
#endif
