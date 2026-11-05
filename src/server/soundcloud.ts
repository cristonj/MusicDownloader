import { MAX_TRACKS } from "@/lib/model";
import { catalogTrack, type CatalogTrack } from "./catalog";
import { HttpError } from "./security";
import { publicFetch } from "./upstream";
const BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
export const TRENDING_URL =
  "https://soundcloud.com/discover/sets/trending-by-genre:all-genres";
export const isDiscoverSet = (url: URL) =>
  /^\/discover\/sets\/[a-z0-9:_-]+\/?$/i.test(url.pathname);
interface ScTrack {
  id: number;
  title?: string;
  duration?: number;
  permalink_url?: string;
  artwork_url?: string | null;
  policy?: string;
  user?: { username?: string; avatar_url?: string };
}
type Hydration = { hydratable?: string; data?: any }[];
// A discover page carries its track IDs and the page's public client ID.
export function readDiscoverPage(html: string) {
  const script = html.match(
    /window\.__sc_hydration\s*=\s*(\[.*?\]);\s*<\/script>/s,
  );
  if (!script) return undefined;
  const hydration = JSON.parse(script[1]) as Hydration;
  const playlist = hydration.find(
    (item) => item.hydratable === "systemPlaylist",
  )?.data;
  const clientId = hydration.find((item) => item.hydratable === "apiClient")
    ?.data?.id;
  if (!Array.isArray(playlist?.tracks) || typeof clientId !== "string")
    return undefined;
  return {
    title: String(playlist.title || "SoundCloud"),
    ids: playlist.tracks
      .map((track: { id?: unknown }) => track.id)
      .filter((id: unknown): id is number => typeof id === "number") as number[],
    clientId,
  };
}
export function discoverTrack(track: ScTrack): CatalogTrack | undefined {
  const link = track.permalink_url;
  if (!track.title || !link?.startsWith("https://soundcloud.com/"))
    return undefined;
  const image = track.artwork_url || track.user?.avatar_url;
  return catalogTrack(
    {
      title: track.title,
      uploader: track.user?.username,
      duration: track.duration ? track.duration / 1000 : undefined,
      thumbnail: image?.replace(/-large\.(\w+)$/, "-t300x300.$1"),
      // SNIP tracks only offer a 30-second preview; BLOCK offers nothing.
      // No formats sends them to the same matching as DRM-only tracks.
      formats: ["SNIP", "BLOCK"].includes(track.policy || "") ? [] : undefined,
    },
    link,
  );
}
export async function discoverSet(
  value = TRENDING_URL,
  limit = MAX_TRACKS,
  signal?: AbortSignal,
) {
  const limited = () =>
    signal
      ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
      : AbortSignal.timeout(12000);
  const headers = { "User-Agent": BROWSER, Accept: "text/html,*/*" };
  const page = await publicFetch(value, { headers, signal: limited() });
  const found = page.ok && readDiscoverPage(await page.text().catch(() => ""));
  if (!found)
    throw new HttpError(502, "SoundCloud's trending page could not be read.");
  const ids = found.ids.slice(0, limit);
  // The page gives only IDs; SoundCloud's track lookup takes 50 at a time.
  const batches = Array.from({ length: Math.ceil(ids.length / 50) }, (_, i) =>
    ids.slice(i * 50, (i + 1) * 50),
  );
  const pages = await Promise.all(
    batches.map(async (batch) => {
      const response = await publicFetch(
        `https://api-v2.soundcloud.com/tracks?ids=${batch.join(",")}&client_id=${encodeURIComponent(found.clientId)}`,
        { headers: { "User-Agent": BROWSER }, signal: limited() },
      );
      if (!response.ok)
        throw new HttpError(502, "SoundCloud's track list could not be read.");
      return (await response.json()) as ScTrack[];
    }),
  );
  // The lookup returns tracks in its own order; the chart's order is the point.
  const byId = new Map(pages.flat().map((track) => [track.id, track]));
  const tracks = ids.flatMap((id) => {
    const known = byId.get(id);
    const track = known && discoverTrack(known);
    return track ? [track] : [];
  });
  if (!tracks.length)
    throw new HttpError(502, "SoundCloud's trending list came back empty.");
  return { title: `Trending: ${found.title}`, tracks };
}
