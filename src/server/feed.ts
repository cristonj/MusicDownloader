import { HttpError, signTicket } from "./security";
import { extract } from "./extractor";
import { resolveCatalog, searchResults, type CatalogTrack } from "./catalog";
import { itunesSearch } from "./apple";
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
// One screenful per service: enough to browse, small enough for one response.
export const FEED_SIZE = 25;
type Feed = { title: string; tracks: CatalogTrack[] };
// Charts and searches are the same for everyone, so a short memory keeps a
// browsed page from asking the services again on every load. Entries expire
// well before the download tickets they carry.
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { time: number; feed: Feed }>();
export async function feedFor(
  provider: Provider,
  query: string,
  signal?: AbortSignal,
): Promise<Feed> {
  if (!FEED_PROVIDERS.includes(provider))
    throw new HttpError(
      400,
      `${provider} publishes no public chart or search, so it has no feed.`,
    );
  const key = `${provider}:${query}`;
  const cached = cache.get(key);
  if (cached && cached.time > Date.now() - CACHE_MS) return cached.feed;
  const feed = await readFeed(provider, query, signal);
  if (cache.size > 200) cache.clear();
  cache.set(key, { time: Date.now(), feed });
  return feed;
}
async function readFeed(
  provider: Provider,
  query: string,
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
    return { title: result.title, tracks: result.tracks.slice(0, FEED_SIZE) };
  }
  if (provider === "Spotify")
    throw new HttpError(
      422,
      "Spotify's search needs an account, so only its chart is shown here. Paste a Spotify link to import anything else.",
    );
  if (provider === "Apple Music") {
    const songs = await itunesSearch(query, FEED_SIZE);
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
    `${youtube ? "ytsearch" : "scsearch"}${FEED_SIZE}:${query}`,
    true,
    signal,
  );
  const tracks = searchResults(found.entries || [], youtube, FEED_SIZE);
  if (!tracks.length)
    throw new HttpError(422, `${provider} found nothing for that search.`);
  return { title: query, tracks };
}
