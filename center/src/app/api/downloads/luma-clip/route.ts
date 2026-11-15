import { clipExtensionArchive } from "@/server/clipExtension";

// Public, fixed and content-free: all source ships in this same Center release.
export async function GET() {
  try {
    return new Response(await clipExtensionArchive(), { headers: {
      "content-type": "application/gzip",
      "content-disposition": 'attachment; filename="luma-clip.tar.gz"',
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    } });
  } catch {
    return Response.json({ error: "extension_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
