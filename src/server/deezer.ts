import { isArtworkUrl } from "@/lib/model";
import { HttpError } from "./security";
import { publicFetch } from "./upstream";
// Deezer's public catalog needs no account. It supplies names only; the audio
// still comes from the uploads matched to them.
export async function deezerSearch(
  query: string,
  limit: number,
  signal?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(10000);
  const response = await publicFetch(
    `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    { signal: signal ? AbortSignal.any([signal, timeout]) : timeout },
  );
  const result = (await response.json().catch(() => null)) as {
    data?: {
      title?: string;
      duration?: number;
      artist?: { name?: string };
      album?: { cover_medium?: string };
    }[];
  } | null;
  if (!response.ok || !Array.isArray(result?.data))
    throw new HttpError(502, "Deezer's catalog could not be searched.");
  return result.data.flatMap((song) => {
    if (!song.title) return [];
    const cover = song.album?.cover_medium;
    return [
      {
        title: song.title.slice(0, 300),
        artist: (song.artist?.name || "").slice(0, 200),
        duration: song.duration,
        artwork: cover && isArtworkUrl(cover) ? cover : undefined,
      },
    ];
  });
}
