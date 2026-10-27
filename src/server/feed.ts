import { HttpError, signTicket } from "./security";
import { extract } from "./extractor";
import {
  resolveCatalog,
  searchResults,
  songName,
  type CatalogTrack,
} from "./catalog";
import { artworkSearch, itunesSearch } from "./apple";
import type { Provider } from "@/lib/model";
// Services whose own front page is public. Amazon Music and Bandcamp publish
// neither a chart nor a search anyone can read without an account.
export const FEED_PROVIDERS: Provider[] = [
  "YouTube",
  "Spotify",
  "Apple Music",
  "SoundCloud",
];
// Each service's own public chart of the moment.
const CHARTS: Partial<Record<Provider, string>> = {
  YouTube:
    "https://www.youtube.com/playlist?list=PL4fGSI1pDJn6puJdseH2Rt9sMvt9E2M4i",
  Spotify: "https://open.spotify.com/playlist/37i9dQZEVXbMDoHDwVN2tF",
  "Apple Music":
    "https://music.apple.com/us/playlist/top-100-global/pl.d25f5d1181894928af76c85c967f8f31",
};
// One screenful per service; a focused service asks for more of the same list.
export const FEED_SIZE = 25;
export const FEED_MAX = 60;
type Feed = { title: string; tracks: CatalogTrack[] };
// A service that publishes no cover art of its own (Spotify's public chart)
// still gets one per song, looked up by name a few at a time.
async function withArtwork(tracks: CatalogTrack[]): Promise<CatalogTrack[]> {
  const missing = tracks.filter((track) => !track.artwork);
  if (!missing.length) return tracks;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, missing.length) }, async () => {
      while (next < missing.length) {
        const track = missing[next++];
        track.artwork = await artworkSearch(track.title, track.artist);
      }
    }),
  );
  return tracks;
}
// Uploads are titled for a video page; the feed lists them as songs.
const asSongs = (tracks: CatalogTrack[]): CatalogTrack[] =>
  tracks.map((track) => {
    const named = songName(track.title, track.artist);
    return named.title === track.title && named.artist === track.artist
      ? track
      : { ...track, ...named, fullTitle: track.title };
  });
// Charts and searches are the same for everyone, so a short memory keeps a
// browsed page from asking the services again on every load. Entries expire
// well before the download tickets they carry.
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { time: number; feed: Feed }>();
export async function feedFor(
  provider: Provider,
  query: string,
  size = FEED_SIZE,
  signal?: AbortSignal,
): Promise<Feed> {
  if (!FEED_PROVIDERS.includes(provider))
    throw new HttpError(
      400,
      `${provider} publishes no public chart or search, so it has no feed.`,
    );
  const limit = Math.min(FEED_MAX, Math.max(1, Math.trunc(size) || FEED_SIZE));
  const key = `${provider}:${limit}:${query}`;
  const cached = cache.get(key);
  if (cached && cached.time > Date.now() - CACHE_MS) return cached.feed;
  const feed = await readFeed(provider, query, limit, signal);
  if (cache.size > 200) cache.clear();
  cache.set(key, { time: Date.now(), feed });
  return feed;
}
async function readFeed(
  provider: Provider,
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<Feed> {
  if (!query) {
    const chart = CHARTS[provider];
    if (!chart)
      throw new HttpError(
        422,
        `${provider} publishes no public chart. Search it instead.`,
      );
    const result = await resolveCatalog(chart, signal);
    const tracks = result.tracks.slice(0, limit);
    return {
      title: result.title,
      tracks: await withArtwork(
        provider === "YouTube" ? asSongs(tracks) : tracks,
      ),
    };
  }
  if (provider === "Spotify")
    throw new HttpError(
      422,
      "Spotify's search needs an account, so only its chart is shown here. Paste a Spotify link to import anything else.",
    );
  if (provider === "Apple Music") {
    const songs = await itunesSearch(query, limit);
    if (!songs.length)
      throw new HttpError(422, "Apple Music found nothing for that search.");
    return {
      title: query,
      tracks: songs.map((track) => ({
        ...track,
        matchTicket: signTicket({ kind: "match", ...track, origin: provider }),
      })),
    };
  }
  const youtube = provider === "YouTube";
  const found = await extract(
    `${youtube ? "ytsearch" : "scsearch"}${limit}:${query}`,
    true,
    signal,
  );
  const tracks = asSongs(searchResults(found.entries || [], youtube, limit));
  if (!tracks.length)
    throw new HttpError(422, `${provider} found nothing for that search.`);
  return { title: query, tracks: await withArtwork(tracks) };
}
