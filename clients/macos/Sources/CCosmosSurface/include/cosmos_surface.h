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
    COSMOS_SURFACE_MAX_CONTEXT_APP_BYTES = 64,
    COSMOS_SURFACE_MAX_CONTEXT_BYTES = 8000,
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
/* Send text with the request's own explicit destination: target is NULL with
 * target_length 0 for none, or exactly "macos", "linux", "android" or
 * "android_tv" (UTF-8, no NUL). Cosmos weighs it exactly like a hint from
 * cognition and the client's wins when both exist; it never makes a hidden or
 * unapproved screen eligible. Any other target is INVALID_ARGUMENT. An exact
 * retry replays the same target. */
int32_t cosmos_surface_send_text_to(CosmosSurface *surface, const uint8_t *text,
                                   size_t text_length, const uint8_t *target,
                                   size_t target_length);
/* Send text with bounded text from this installation's own screen: app (1 to
 * MAX_CONTEXT_APP_BYTES) and context (1 to MAX_CONTEXT_BYTES) are required
 * non-blank UTF-8; target as for send_text_to. The turn becomes private: the
 * reply can appear only on a personal surface the owner declared in Center,
 * and the screen text reaches cognition only under the owner's screen-context
 * permission for this installation; without it Cosmos shows why on a personal
 * surface and sends the text nowhere. Text plus escaped context must fit the
 * 12 KiB transport envelope; otherwise the operation reports invalid_input.
 * Screen text is journaled with the request until its receipt. */
int32_t cosmos_surface_send_text_with_context(CosmosSurface *surface,
                                             const uint8_t *text, size_t text_length,
                                             const uint8_t *app, size_t app_length,
                                             const uint8_t *context, size_t context_length,
                                             const uint8_t *target, size_t target_length);
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
/* Acknowledge the current "task": this installation bound that exact command
 * from its own copy of the owner's policy and it is legal here. On an action
 * channel this is NOT an outcome and Cosmos records none: never acknowledge a
 * command this platform will not attempt. */
int32_t cosmos_surface_acknowledge_task(CosmosSurface *surface);
/* Report the outcome of the current "task" only after the platform observed
 * it. `report` is bounded UTF-8 JSON:
 *   {"outcome":"completed|refused|failed|cancelled|unknown",
 *    "evidence":{"kind":"open","resolvedApp":BUNDLE_ID?,"opened":bool,
 *                "documentDigest":HEX64?}
 *              |{"kind":"route","resolvedApp":PACKAGE?,"launched":bool,
 *                "navigating":bool}
 *              |{"kind":"playback","provider":ID,
 *                "state":"playing|buffering|launched","positionMs":integer,
 *                "itemDigest":HEX64}
 *              |{"kind":"command","entryId":ID,"exitCode":integer?,
 *                "durationMs":integer,"outputBytes":integer,"truncated":bool}
 *              |{"kind":"declined","reason":"no_handler|locked|not_permitted|
 *                unresolvable|version_changed|entry_changed|no_attestation"},
 *    "output":STRING?}
 * The evidence kind must match the task's channel. "completed" requires
 * evidence that shows it: opened, navigating, or playback state "playing". A
 * launch the platform could not observe further is "unknown" with
 * launched/state:"launched", never "completed"; reporting completed for an
 * effect the platform did not observe is a false outcome claim. A non-zero
 * exitCode is a command that ran, so it is "completed" evidence, not a
 * failure. "refused" is exactly the declined evidence, and nothing else is.
 * "cancelled" promises this platform can prove nothing started or that it
 * stopped it; otherwise report "unknown". `output` is the command's own bytes,
 * at most 6144 of them, allowed only with command evidence; Cosmos routes it
 * as private content, never into its ledger. Exactly one report per task. */
int32_t cosmos_surface_report(CosmosSurface *surface, const uint8_t *report,
                             size_t length);
/* Progress for a running task: a sequence from 1 to 60 and elapsed
 * milliseconds. Unsequenced and idempotent, it consumes no ordered slot, and
 * it renews the task's deadline and the turn's worker lease. It claims no
 * outcome. Without progress a running command's deadline is the channel's own
 * report budget; with it, ten seconds between messages. */
int32_t cosmos_surface_progress(CosmosSurface *surface, uint32_t sequence,
                               int64_t elapsed_ms);
/* Answer the current "confirmation": granted 0 or 1, with the attestation the
 * platform actually obtained ("foreground_tap" or "device_owner_auth"). A
 * grant needs an attestation at least as strong as confirmation.attestation;
 * anything weaker is refused by Cosmos and is not an answer. Pass NULL/0 for
 * the attestation only when declining. Dismissing the panel must answer
 * nothing at all: the ceremony then expires, which denies by default. */
int32_t cosmos_surface_grant(CosmosSurface *surface, int32_t granted,
                            const uint8_t *attestation,
                            size_t attestation_length);
/* Copy the current spoken reply's complete audio bytes (the snapshot's
 * speech.byteLength). EMPTY when no reply is current; BUFFER_TOO_SMALL sets
 * *written to the required size. Bytes are audio/mpeg. */
int32_t cosmos_surface_speech_audio(CosmosSurface *surface, uint8_t *output,
                                   size_t capacity, size_t *written);
int32_t cosmos_surface_disconnect(CosmosSurface *surface);

/* Nonblocking safe JSON snapshot, UTF-8 bytes without a trailing NUL:
 * {version:1,kind:"state",operation:"prepare|connect|send_text|send_text_to|
 * send_text_with_context|retry_pending|cancel|set_visible|acknowledge|
 * acknowledge_speech|acknowledge_task|report|progress|grant|display|speech|
 * invitation|status|task|confirmation|disconnect|heartbeat",
 * outcome:"ok|error",error:null|STATIC_CODE,
 * connected:bool,pendingOpen:bool,needsReconnect:bool,
 * descriptor:null|PUBLIC_DESCRIPTOR,
 * pending:null|{kind:"text|heartbeat|cancel|state|acknowledge|report|grant",
 * instanceId:UUID,sequence:integer,canRetry:bool},
 * lastUnknown:null|SAME_PENDING_SHAPE,
 * admission:null|{turnId:UUID,generation:integer,duplicate:bool},
 * visible:bool,
 * display:null|{actionId:UUID,turnId:UUID,generation:integer,
 * contentDigest:HEX64,expiresAtMs:integer,
 * content:{kind:"text",text:STRING}|{kind:"places",query:STRING,
 * items:[{placeId,name,address,sourceUrl:null|HTTPS}],attributions:[STRING]}
 * |{kind:"choices",title:STRING,items:[{id:"1".."8",title:STRING,detail:STRING}]},
 * credits:[[{kind:"text",text}|{kind:"link",text,href:HTTPS}]],
 * privacy:"public|shared_room|near_user|private"},
 * speech:null|{actionId:UUID,turnId:UUID,generation:integer,contentDigest:HEX64,
 * expiresAtMs:integer,text:STRING,format:"audio/mpeg",byteLength:integer},
 * invitation:null|{id:UUID,kind:"card|task",
 * origin:"pin|browser|macos|linux|android|android_tv",
 * privacy:"public|shared_room|near_user|private",expiresAtMs:integer},
 * status:null|{turnId:UUID,generation:integer,
 * state:"working|waiting|confirming|acting|shown|spoken|done|refused|nowhere|
 * unknown",
 * surfacePlatform:null|"pin|browser|macos|linux|android|android_tv",
 * privacy:"public|shared_room|near_user|private"},
 * task:null|{actionId:UUID,turnId:UUID,generation:integer,
 * channel:"action.open|action.route|action.play|action.run",
 * contentDigest:HEX64,idempotencyKey:HEX64,
 * operation:{kind:"open",locator:{scheme:"https",url:URL}
 *                              |{scheme:"app",id:BUNDLE_ID}
 *                              |{scheme:"file",rootId:ID,relative:PATH},
 *            version:HEX64?,position:{kind:"line",line:N}|{kind:"page",page:N}
 *                                    |{kind:"fragment",value:STRING}?,
 *            label:STRING}
 *           |{kind:"route",placeId,name,address,lat,lng}
 *           |{kind:"play",title,query,providers:[ID],itemDigest:HEX64}
 *           |{kind:"run",entryId,label,entryDigest:HEX64,argvDigest:HEX64,
 *             budgetMs:integer,mutates:bool},
 * expiresAtMs:integer,reportByMs:integer,
 * privacy:"public|shared_room|near_user|private"},
 * confirmation:null|{grantId:UUID,actionId:UUID,turnId:UUID,
 * generation:integer,
 * description:{kind:"device_action",verb,subject,deviceKind,effect,
 * class:"public|shared_room|near_user|private"},
 * descriptionDigest:HEX64,risk:"low|moderate|high",
 * attestation:"foreground_tap|device_owner_auth",
 * privacy:"public|shared_room|near_user|private",expiresAtMs:integer},
 * revoked:null|{actionId:UUID,reason:"cancelled|preempted|superseded|expired|
 * revalidation_failed"},
 * eventsSkipped:N}
 * A "choices" card is a numbered list of two to eight options; render every
 * id, title and detail verbatim in order. A later request may name an item
 * by its number ("play trailer for number two").
 * A "status" operation reports what Cosmos committed about the turn this
 * installation originated: working (begun), waiting (an action is proposed
 * or dispatched to a surface of the named kind), confirming (a command waits
 * for someone's confirmation at the device that would carry it out), acting
 * (a device is carrying one out and nothing is claimed yet), shown or spoken
 * (that action was acknowledged there), done or refused (a device reported
 * that it did or did not carry the command out), nowhere (nothing could take
 * it) or unknown (outcome unknown). It carries no content and no reason:
 * privacy suppression, capability misses, exhausted budgets, declines and
 * ordinary re-routing look identical, so express it as understated "heard,
 * handled elsewhere" and nothing more.
 * privacy is the class the status is expressed at, never above this
 * installation's own ceiling. A terminal state ends the turn's status frames.
 * An "invitation" operation reports that a private card (kind "card") or a
 * command (kind "task") is waiting for this installation, or that the offer
 * was withdrawn. It carries no content: show a generic prompt (a notification
 * may say only that something is ready) and report visible from an unlocked
 * foreground to receive it. No platform may begin a command in the
 * background, so a task waits exactly the way a private card does.
 * A "task" operation reports a command dispatched to this installation, or
 * one that was retired. Re-verify it against this installation's own copy of
 * the owner's policy before doing anything: an unknown entry id, an argv
 * digest that does not match, a host that is not allowed or a root this
 * installation does not have are all report{outcome:"refused",
 * evidence:{kind:"declined",...}}, never silence. Never build a command from
 * strings: argv comes from the local policy copy keyed by entryId, with no
 * shell and no interpolation. Deduplicate on idempotencyKey within a
 * ten-minute window; a repeat re-sends the existing report and never
 * re-executes. When "revoked" names the task, stop what can be stopped and
 * report cancelled only if nothing started or this platform stopped it.
 * A "confirmation" operation reports that this installation is the venue for
 * a ceremony, or that it ended. Render description from this platform's own
 * strings file, never as JSON; show a visible countdown; make declining
 * exactly one control away and the same weight as accepting; and make
 * dismissal answer nothing. A "display"
 * card whose privacy is above shared_room is private: show it here only, never
 * in a notification or preview, and report not visible when the app leaves the
 * foreground; Cosmos retires it.
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
