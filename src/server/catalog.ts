import { MAX_TRACKS } from "@/lib/model";
import { allowedSource, HttpError, signTicket } from "./security";
import { extract, type Extracted } from "./extractor";
import { spotifyMetadata } from "./spotify";
export interface CatalogTrack {
  title: string;
  artist: string;
  duration?: number;
  mediaUrl?: string;
  sourceUrl?: string;
  extension?: string;
  matchedTitle?: string;
  matchConfidence?: number;
  error?: string;
  matchTicket?: string;
}
const words = (s: string) =>
  new Set(s.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
export function matchScore(
  title: string,
  artist: string,
  duration: number | undefined,
  candidate: Extracted,
): number {
  const target = words(title),
    found = words(candidate.title || ""),
    names = words(artist);
  const foundNames = new Set([
    ...found,
    ...words(candidate.channel || candidate.uploader || ""),
  ]);
  const titleScore =
    [...target].filter((x) => found.has(x)).length / Math.max(1, target.size);
  const artistScore =
    [...names].filter((x) => foundNames.has(x)).length /
    Math.max(1, names.size);
  const durationScore =
    duration && candidate.duration
      ? Math.max(
          0,
          1 -
            Math.abs(duration - candidate.duration) /
              Math.max(10, duration * 0.12),
        )
      : 0.5;
  let score = 0.5 * titleScore + 0.25 * artistScore + 0.25 * durationScore;
  for (const version of [
    "live",
    "remix",
    "cover",
    "karaoke",
    "instrumental",
    "slowed",
    "sped",
    "acoustic",
  ])
    if (found.has(version) !== target.has(version)) score -= 0.3;
  if (titleScore < 0.65) score -= 0.4;
  return Math.max(0, Math.min(1, score));
}
function downloadTrack(track: CatalogTrack, url: string): CatalogTrack {
  const source = allowedSource(url).href;
  return {
    ...track,
    sourceUrl: source,
    mediaUrl: `/api/audio?ticket=${signTicket({ kind: "source", url: source })}`,
  };
}
const stub = (entry: Extracted) =>
  !entry.title &&
  /^https:\/\/(?:[a-z0-9-]+\.)?soundcloud\.com\//.test(entry.url || "");
// Flat SoundCloud sets carry no titles, and after the first five tracks only
// API links by ID. Look each one up so it keeps its title and artist.
async function completeStubs(entries: Extracted[], signal?: AbortSignal) {
  const pending = entries.flatMap((entry, index) =>
    stub(entry) ? [index] : [],
  );
  if (!pending.length) return;
  const deadline = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(40000)])
    : AbortSignal.timeout(40000);
  await Promise.all(
    Array.from({ length: Math.min(8, pending.length) }, async () => {
      while (pending.length && !deadline.aborted) {
        const index = pending.shift()!,
          entry = entries[index];
        try {
          const found = await extract(entry.url!, true, deadline);
          entries[index] = {
            ...entry,
            title: found.title,
            track: found.track,
            artist: found.artist,
            uploader: found.uploader,
            duration: found.duration ?? entry.duration,
            webpage_url: found.webpage_url,
            ext: found.ext,
          };
        } catch {
          // Keep the original link; the track still downloads without a title.
        }
      }
    }),
  );
  if (signal?.aborted) throw new HttpError(499, "Import cancelled.");
}
export async function resolveCatalog(value: string, signal?: AbortSignal) {
  const url = allowedSource(value);
  if (["spotify.link", "open.spotify.com"].includes(url.hostname)) {
    const result = await spotifyMetadata(url.href);
    return {
      ...result,
      tracks: result.tracks.map((track) => ({
        ...track,
        matchTicket: signTicket({ kind: "match", ...track }),
      })),
    };
  }
  const info = await extract(url.href, true, signal);
  const entries = info.entries || [info];
  if (entries.length > MAX_TRACKS)
    throw new HttpError(422, "Import up to 100 tracks at a time.");
  if (info.entries) await completeStubs(entries, signal);
  const tracks = entries.map((entry) => {
    const track: CatalogTrack = {
      title: entry.track || entry.title || "Untitled",
      artist: entry.artist || entry.uploader || entry.channel || "",
      duration: entry.duration,
      extension: entry.ext || "m4a",
    };
    if (entry.is_live)
      return { ...track, error: "Live streams cannot be downloaded." };
    let source = entry.webpage_url || entry.url || url.href;
    if (/^[a-zA-Z0-9_-]{11}$/.test(source))
      source = `https://www.youtube.com/watch?v=${source}`;
    // A single extracted entry may have a CDN URL rather than its public page URL.
    try {
      return downloadTrack(track, info.entries ? source : url.href);
    } catch {
      return {
        ...track,
        error: "This entry has no downloadable audio source.",
      };
    }
  });
  if (!tracks.length)
    throw new HttpError(422, "This link has no downloadable tracks.");
  return { title: info.title || "Music", tracks };
}
export async function matchTrack(
  track: { title: string; artist: string; duration?: number },
  signal?: AbortSignal,
): Promise<CatalogTrack> {
  try {
    const found = await extract(
      `ytsearch5:${track.artist} ${track.title} official audio`,
      true,
      signal,
    );
    const candidates = (found.entries || []).filter(
      (x) => !x.is_live && /^[a-zA-Z0-9_-]{11}$/.test(x.id || ""),
    );
    const best = candidates.sort(
      (a, b) =>
        matchScore(track.title, track.artist, track.duration, b) -
        matchScore(track.title, track.artist, track.duration, a),
    )[0];
    const score = best
      ? matchScore(track.title, track.artist, track.duration, best)
      : 0;
    if (!best || score < 0.58)
      return {
        ...track,
        error: "No close audio match found. Add a source link for this track.",
      };
    return downloadTrack(
      {
        ...track,
        extension: "m4a",
        matchedTitle: best.title,
        matchConfidence: score,
      },
      `https://www.youtube.com/watch?v=${best.id}`,
    );
  } catch {
    return {
      ...track,
      error:
        "Matching is temporarily unavailable. Re-import this track to try again.",
    };
  }
}
