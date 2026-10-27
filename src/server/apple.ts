import { HttpError } from "./security";
import { publicFetch } from "./upstream";
import { MAX_TRACKS } from "@/lib/model";
export interface MetadataTrack {
  title: string;
  artist: string;
  duration?: number;
}
interface ItunesResult {
  wrapperType?: string;
  kind?: string;
  trackName?: string;
  collectionName?: string;
  artistName?: string;
  trackTimeMillis?: number;
  trackId?: number;
}
async function appleFetch(value: string): Promise<Response> {
  let url = new URL(value);
  for (let i = 0; i < 4; i++) {
    if (
      url.protocol !== "https:" ||
      !["music.apple.com", "geo.music.apple.com", "itunes.apple.com"].includes(
        url.hostname,
      ) ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      throw new HttpError(
        400,
        "Use an Apple Music song, album, or playlist link.",
      );
    const response = await publicFetch(url.href, {
      signal: AbortSignal.timeout(10000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = new URL(response.headers.get("location") || "", url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(
        422,
        "Apple Music could not open this link. Check that it is public.",
      );
    }
    return response;
  }
  throw new HttpError(422, "Use the full music.apple.com link.");
}
// The public iTunes catalogue names songs, their artists, and their lengths
// without an API key, which is all the YouTube match needs.
async function itunesLookup(
  ids: string[],
  country: string,
  entity?: string,
): Promise<ItunesResult[]> {
  const results: ItunesResult[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const url = new URL("https://itunes.apple.com/lookup");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("country", country);
    url.searchParams.set("limit", "200");
    if (entity) url.searchParams.set("entity", entity);
    const response = await appleFetch(url.href);
    const data = (await response.json().catch(() => null)) as {
      results?: ItunesResult[];
    } | null;
    if (!data || !Array.isArray(data.results))
      throw new HttpError(
        422,
        "Apple Music did not return this track list. Try another link.",
      );
    results.push(...data.results);
  }
  return results;
}
const songTrack = (song: ItunesResult): MetadataTrack => ({
  title: (song.trackName || "Untitled").slice(0, 300),
  artist: (song.artistName || "").slice(0, 200),
  duration:
    typeof song.trackTimeMillis === "number"
      ? song.trackTimeMillis / 1000
      : undefined,
});
const isSong = (result: ItunesResult) =>
  result.wrapperType === "track" && result.kind === "song";
// Playlists are not in the iTunes catalogue, but the public playlist page
// publishes its track list as schema.org metadata.
async function playlistTracks(url: URL, country: string) {
  const response = await appleFetch(url.href);
  const html = (await response.text()).slice(0, 8 * 1024 * 1024);
  let playlist: {
    name?: string;
    track?: { name?: string; url?: string; duration?: string }[];
  } | null = null;
  for (const [, body] of html.matchAll(
    /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
  )) {
    try {
      const data = JSON.parse(body);
      if (data?.["@type"] === "MusicPlaylist" && Array.isArray(data.track))
        playlist = data;
    } catch {}
  }
  if (!playlist?.track?.length)
    throw new HttpError(
      422,
      "This Apple Music playlist is not public, so its track list cannot be read.",
    );
  const entries = playlist.track.slice(0, MAX_TRACKS);
  // Playlist metadata names each song but not its artist; the iTunes
  // catalogue supplies the artist and exact length for the song IDs.
  const songIds = entries.map(
    (entry) => entry.url?.match(/\/song\/[^/]+\/(\d+)/)?.[1] || "",
  );
  const catalogue = new Map<string, ItunesResult>();
  const known = songIds.filter(Boolean);
  if (known.length)
    for (const song of await itunesLookup([...new Set(known)], country))
      if (isSong(song) && song.trackId)
        catalogue.set(String(song.trackId), song);
  return {
    title: playlist.name || "Apple Music",
    tracks: entries.map((entry, index) => {
      const song = catalogue.get(songIds[index]);
      if (song) return songTrack(song);
      const seconds = entry.duration?.match(
        /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/,
      );
      // The playlist names its curator, not the song's artist, so a song the
      // catalogue does not list is matched and tagged by title alone.
      return {
        title: (entry.name || "Untitled").slice(0, 300),
        artist: "",
        duration: seconds
          ? Number(seconds[1] || 0) * 3600 +
            Number(seconds[2] || 0) * 60 +
            Number(seconds[3] || 0)
          : undefined,
      };
    }),
  };
}
// The catalogue's own search, for the Apple Music column of the feed.
export async function itunesSearch(
  term: string,
  limit: number,
  country = "us",
): Promise<MetadataTrack[]> {
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", term);
  url.searchParams.set("entity", "song");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("country", country);
  const response = await appleFetch(url.href);
  const data = (await response.json().catch(() => null)) as {
    results?: ItunesResult[];
  } | null;
  if (!data || !Array.isArray(data.results))
    throw new HttpError(422, "Apple Music could not run that search.");
  return data.results.filter(isSong).map(songTrack);
}
export async function appleMusicMetadata(
  value: string,
): Promise<{ title: string; tracks: MetadataTrack[]; notice?: string }> {
  const url = new URL(value);
  // Links carry an optional storefront, an optional slug, and the ID:
  // /us/album/in-between-dreams/1440857781, /playlist/<slug>/pl.<id>.
  const path = url.pathname.match(
    /^\/(?:([a-z]{2})\/)?(album|song|playlist)\/(?:[^/]+\/)?([A-Za-z0-9.-]+)\/?$/,
  );
  if (!path)
    throw new HttpError(
      400,
      "Use an Apple Music song, album, or playlist link.",
    );
  const [, country = "us", type, identifier] = path;
  const song = url.searchParams.get("i") || "";
  if (type === "playlist") {
    if (!/^pl\.[A-Za-z0-9-]+$/.test(identifier))
      throw new HttpError(400, "Use a full Apple Music playlist link.");
    return playlistTracks(url, country);
  }
  if (!/^\d{1,15}$/.test(identifier))
    throw new HttpError(
      400,
      "Use an Apple Music song, album, or playlist link.",
    );
  if (type === "song" || song) {
    if (song && !/^\d{1,15}$/.test(song))
      throw new HttpError(400, "Use an Apple Music song link.");
    const [found] = (await itunesLookup([song || identifier], country)).filter(
      isSong,
    );
    if (!found)
      throw new HttpError(
        422,
        "Apple Music has no public details for this song. Try its album link.",
      );
    return {
      title: found.trackName || "Apple Music",
      tracks: [songTrack(found)],
    };
  }
  const results = await itunesLookup([identifier], country, "song");
  const album = results.find((result) => result.wrapperType === "collection");
  const songs = results.filter(isSong);
  if (!songs.length)
    throw new HttpError(
      422,
      "Apple Music has no public track list for this album.",
    );
  if (songs.length > MAX_TRACKS)
    throw new HttpError(422, `Import up to ${MAX_TRACKS} tracks at a time.`);
  return {
    title: album?.collectionName || "Apple Music",
    tracks: songs.map(songTrack),
  };
}
