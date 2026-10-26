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
  if (entries.length > MAX_TRACKS)
    throw new HttpError(422, `Import up to ${MAX_TRACKS} tracks at a time.`);
  // Spotify's public (signed-out) view lists at most 100 playlist tracks.
  const partial =
    count > entries.length ||
    (data.type === "playlist" && entries.length >= 100);
  return {
    title: data.name || "Spotify",
    ...(partial
      ? {
          notice:
            "Spotify only shows the first 100 tracks of a playlist publicly, so longer playlists import their first 100. Split it into smaller playlists to get the rest.",
        }
      : {}),
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
