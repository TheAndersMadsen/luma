/**
 * The @capturemodal parallel slot renders nothing by default. It only fills when
 * the intercepting route (.)captures/[id] matches during a soft navigation from
 * the grid; on every other route — and on a hard load of /captures/[id] — the
 * slot is empty and the full page renders in {children}.
 */
export default function CaptureModalDefault() {
  return null;
}
