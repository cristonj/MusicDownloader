import { helperConnection, sourceFetch } from "./helper";
import { trackFromItem } from "./sources";
import { isArtworkUrl, type Provider, type Track } from "./model";
// The services whose own chart or search is public. Amazon Music and Bandcamp
// publish neither without an account, so they have no column.
export const FEED_PROVIDERS: Provider[] = [
  "YouTube",
  "Spotify",
  "Apple Music",
  "SoundCloud",
];
export interface FeedRow {
  transport?: "helper";
  title: string;
  fullTitle?: string;
  artist: string;
  duration?: number;
  artwork?: string;
  mediaUrl?: string;
  sourceUrl?: string;
  extension?: string;
  matchTicket?: string;
  error?: string;
}
export interface FeedColumn {
  provider: Provider;
  title: string;
  rows: FeedRow[];
}
const row = (item: Record<string, unknown>): FeedRow => ({
  title: typeof item.title === "string" ? item.title.slice(0, 300) : "Untitled",
  fullTitle:
    typeof item.fullTitle === "string"
      ? item.fullTitle.slice(0, 300)
      : undefined,
  artist: typeof item.artist === "string" ? item.artist.slice(0, 200) : "",
  duration: typeof item.duration === "number" ? item.duration : undefined,
  artwork:
    typeof item.artwork === "string" && isArtworkUrl(item.artwork)
      ? item.artwork
      : undefined,
  mediaUrl: typeof item.mediaUrl === "string" ? item.mediaUrl : undefined,
  sourceUrl: typeof item.sourceUrl === "string" ? item.sourceUrl : undefined,
  extension: typeof item.extension === "string" ? item.extension : undefined,
  matchTicket:
    typeof item.matchTicket === "string" ? item.matchTicket : undefined,
  error: typeof item.error === "string" ? item.error : undefined,
});
// An empty query asks each service for its own current chart.
export async function loadFeed(
  provider: Provider,
  query: string,
  size: number,
  signal: AbortSignal,
): Promise<FeedColumn> {
  const transport = helperConnection() ? "helper" : undefined;
  const response = await sourceFetch(
    "/api/feed",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, query, size }),
      signal,
    },
    transport,
  );
  const result = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      result?.detail || `${provider} could not be loaded right now.`,
    );
  if (!result || !Array.isArray(result.tracks) || !result.tracks.length)
    throw new Error(`${provider} returned nothing to show.`);
  return {
    provider,
    title:
      typeof result.title === "string" ? result.title.slice(0, 300) : provider,
    rows: result.tracks.map((item: Record<string, unknown>) => ({
      ...row(item),
      transport,
    })),
  };
}
// Rows from a chart of names carry no audio yet; the match runs when the
// listener adds the row, exactly as it does for an imported link.
export async function importRow(
  entry: FeedRow,
  provider: Provider,
  signal: AbortSignal,
): Promise<Track> {
  const transport = entry.transport;
  let item: Record<string, unknown> = { ...entry };
  if (!entry.mediaUrl && entry.matchTicket) {
    const response = await sourceFetch(
      "/api/match",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: entry.matchTicket }),
        signal,
      },
      transport,
    );
    const found = await response.json().catch(() => null);
    item = response.ok
      ? { ...item, ...found }
      : {
          ...item,
          error: found?.detail || "No audio match was found for this track.",
        };
  }
  if (!item.mediaUrl && !item.error)
    item = { ...item, error: "This track has no downloadable audio source." };
  return trackFromItem(item, provider, transport);
}
