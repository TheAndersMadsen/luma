const SPOTIFY_OEMBED = "https://open.spotify.com/oembed";
const MAX_OEMBED_BYTES = 64 * 1024;

function validSpotifyArtwork(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "i.scdn.co" || url.hostname.endsWith(".spotifycdn.com"));
  } catch {
    return false;
  }
}

export async function resolveMusicArtwork(
  provider: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (provider === "youtube_music") {
    if (!/^[A-Za-z0-9_-]{11}$/u.test(id)) throw new Error("invalid YouTube Music track id");
    return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  }
  if (provider !== "spotify" || !/^[A-Za-z0-9]{22}$/u.test(id)) {
    throw new Error("unsupported music artwork provider");
  }

  const endpoint = new URL(SPOTIFY_OEMBED);
  endpoint.searchParams.set("url", `https://open.spotify.com/track/${id}`);
  const response = await fetchImpl(endpoint, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
  });
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (!response.ok || (Number.isFinite(declared) && declared > MAX_OEMBED_BYTES)) {
    throw new Error("music artwork response was unavailable");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_OEMBED_BYTES) {
    throw new Error("music artwork response was too large");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("music artwork response was malformed");
  }
  const artwork = body && typeof body === "object"
    ? (body as { thumbnail_url?: unknown }).thumbnail_url
    : null;
  if (!validSpotifyArtwork(artwork)) throw new Error("music artwork response was unsafe");
  return artwork;
}
