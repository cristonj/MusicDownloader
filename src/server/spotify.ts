import spotifyUrlInfo from "spotify-url-info";
import { HttpError } from "./security";
import { publicFetch } from "./upstream";
import { MAX_TRACKS } from "@/lib/model";
interface SpotifyTrack {
  name?: string;
  title?: string;
  artist?: string;
  subtitle?: string;
  artists?: { name: string }[];
  duration?: number;
  uri?: string;
}
interface SpotifyData extends SpotifyTrack {
  type: string;
  trackList?: SpotifyTrack[];
  trackCount?: number;
  totalCount?: number;
}
async function spotifyFetch(
  value: string,
  options: RequestInit = {},
): Promise<Response> {
  let url = new URL(value);
  for (let i = 0; i < 4; i++) {
    if (
      url.protocol !== "https:" ||
      !["open.spotify.com", "embed.spotify.com", "spotify.link"].includes(
        url.hostname,
      ) ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      throw new HttpError(
        400,
        "Use a Spotify song, album, or public playlist link.",
      );
    const response = await publicFetch(url.href, {
      ...options,
      signal: AbortSignal.timeout(10000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = new URL(response.headers.get("location") || "", url);
      continue;
    }
    if (!response.ok)
      throw new HttpError(
        422,
        "Spotify could not open this public track list. Try another link.",
      );
    return response;
  }
  throw new HttpError(422, "Use the full open.spotify.com link.");
}
export async function spotifyMetadata(value: string) {
  let url = new URL(value);
  if (url.hostname === "spotify.link") {
    const response = await spotifyFetch(url.href);
    url = new URL(response.url);
    await response.body?.cancel();
  }
  const path = url.pathname.replace(/^\/intl-[^/]+\//, "/");
  if (!/^\/(track|album|playlist)\/[a-zA-Z0-9]{22}\/?$/.test(path))
    throw new HttpError(
      400,
      "Use a Spotify song, album, or public playlist link.",
    );
  const client = spotifyUrlInfo(spotifyFetch);
  const data = (await client.getData(
    `https://open.spotify.com${path}`,
  )) as SpotifyData;
  const entries = data.trackList || [data];
  const count = data.trackCount || data.totalCount || entries.length;
  if (count > MAX_TRACKS || entries.length > MAX_TRACKS)
    throw new HttpError(422, "Import a playlist with up to 100 tracks.");
  if (count > entries.length)
    throw new HttpError(
      422,
      "Spotify returned only part of this playlist. Try a smaller public playlist.",
    );
  return {
    title: data.name || "Spotify",
    tracks: entries.map((track) => ({
      title: (track.title || track.name || "Untitled").slice(0, 300),
      artist: (
        track.artist ||
        track.artists?.map((a) => a.name).join(", ") ||
        track.subtitle ||
        ""
      ).slice(0, 200),
      duration:
        typeof track.duration === "number" ? track.duration / 1000 : undefined,
    })),
  };
}
