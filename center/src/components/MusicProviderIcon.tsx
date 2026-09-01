import {
  GenericMusicIcon,
  MusicIcon,
  SpotifyIcon,
  YoutubeMusicIcon,
} from "@/icons";
import type { PresentedMusicProvider } from "@/lib/musicActivityPresentation";

export function MusicProviderIcon({
  provider,
  size = 16,
}: {
  provider: PresentedMusicProvider | null;
  size?: number;
}) {
  if (provider === "youtube_music") return <YoutubeMusicIcon size={size} />;
  if (provider === "spotify") return <SpotifyIcon size={size} />;
  if (provider === "tidal") return <MusicIcon size={size} />;
  return <GenericMusicIcon size={size} />;
}
