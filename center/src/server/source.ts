/*
 * Compatibility barrel for the data seam behind our /api routes.
 *
 * The seam itself now lives in `src/server/domain/`, one module per wearer
 * domain: provenance (the Sourced shape and its constructors), notes, captures,
 * events (My Data), account, contacts, and the dashboard aggregate. Import the
 * owning module directly in new code; this file re-exports the whole surface so
 * existing imports keep working while they migrate, and is deleted when the
 * last importer moves.
 *
 * Humane ran TWO APIs and so does the clone, so the seam talks to both:
 *
 *   REST  (COSMOS_WEBAPI_BASE_URL)  — what .Center itself called
 *     captures  -> GET /capture/captures     Spring Data Page<MemoryDto>
 *     notes     -> GET /notes                Spring Data Page<NoteDto>
 *
 *   gRPC  (COSMOS_ENDPOINT_<WORKLOAD>)       — what the Pin calls
 *     my-data events    -> DeviceEventsHistoryService.QueryEvents
 *     my-data overview  -> derived from QueryEvents counts
 *     memory delete     -> CaptureService.DeleteMemory
 *
 * The split is not a convenience. The decompiled device source has no capture
 * listing RPC in any of three independently compiled copies of CaptureServiceGrpc,
 * and the string `webapi` appears in no APK — listing only ever existed on the
 * web side. Reading captures over gRPC would be inventing history.
 */

export * from "./domain/provenance";
export * from "./domain/notes";
export * from "./domain/captures";
export * from "./domain/events";
export * from "./domain/account";
export * from "./domain/contacts";
export * from "./domain/dashboard";
