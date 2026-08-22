-- cosmos:statement
-- Remove the pre-namespacing `device_status` rows.
--
-- `device_status_storage_owner` (http.rs) has always — since namespacing —
-- formatted its owner key as `{principal}#device:{device_id}`, and it is the
-- SOLE key source for both the write (`device_status_report`) and the admin read
-- (`device_status_admin`). Rows written before that suffix existed are therefore
-- unreachable by every current code path: nothing reads them, nothing overwrites
-- them, and no retention sweep expires them. On the live deployment that is one
-- row, `U:<wearer>|device_status`, holding the wearer's home and secondary Wi-Fi
-- SSID list frozen at 2026-08-08 with an empty serial number.
--
-- That makes it two problems, neither of them an outage: wearer network metadata
-- retained with no way to see or delete it from the product, and a trap for the
-- next person who queries this table by hand while debugging a device-status
-- complaint — they find a plausible, stale snapshot under the obvious key and
-- believe it.
--
-- ONLY `device_status`. The other kinds in this table are keyed by the bare
-- principal ON PURPOSE and are live: `privacy_settings` is written by
-- `PublicPrivacyService.UpdateSettings` under `caller_principal` with no device
-- suffix, and `push_tokens` / `push_queue` are per-wearer, not per-device. A
-- sweep of "principals without `#device:`" across kinds would delete the
-- wearer's current privacy settings and push state.
--
-- Idempotent by construction: a second run matches nothing.
DELETE FROM carry_account_blob
WHERE kind = 'device_status'
  AND strpos(principal, '#device:') = 0;
