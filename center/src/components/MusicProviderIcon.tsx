import {
  GenericMusicIcon,
  MusicIcon,
  SpotifyIcon,
  YoutubeMusicIcon,
} from "@/icons";
import type { MusicProvider } from "@/lib/contracts/music";

export function MusicProviderIcon({
  provider,
  size = 16,
}: {
  provider: MusicProvider | null;
  size?: number;
}) {
  if (provider === "youtube_music") return <YoutubeMusicIcon size={size} />;
  if (provider === "spotify") return <SpotifyIcon size={size} />;
  if (provider === "tidal") return <MusicIcon size={size} />;
  return <GenericMusicIcon size={size} />;
}
