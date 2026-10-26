import { durationLabel, MAX_TRACKS, providerFor } from "@/lib/model";
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
  matchedChannel?: string;
  matchReason?: string;
  matchConfident?: boolean;
  error?: string;
  matchTicket?: string;
  lookupTicket?: string;
  fallbackTicket?: string;
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
    // Altered re-uploads are different audio even at the same length.
    "432hz",
    "8d",
    "nightcore",
    "reverb",
    "boosted",
    "mashup",
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
// Flat SoundCloud sets carry no titles, and after the first five tracks only
// API links by ID. The browser looks each one up with a lookup ticket.
const needsLookup = (entry: Extracted) =>
  !entry.title &&
  /^https:\/\/(?:[a-z0-9-]+\.)?soundcloud\.com\//.test(entry.url || "");
export const DRM_MESSAGE =
  "SoundCloud doesn’t allow this track to be downloaded (DRM).";
// The names to search other providers with when the source refuses the audio.
// SoundCloud uploads often title tracks "Artist - Title".
function searchNames(track: CatalogTrack) {
  const credited = track.title.match(/^(.+?) [-–—] (.+)$/);
  return {
    title: credited ? credited[2] : track.title,
    artist: credited ? credited[1] : track.artist,
    duration: track.duration,
  };
}
function catalogTrack(
  entry: Extracted,
  source: string,
  albumArtist = "",
): CatalogTrack {
  const track: CatalogTrack = {
    title: entry.track || entry.title || "Untitled",
    artist:
      entry.artist || entry.uploader || entry.channel || albumArtist || "",
    duration: entry.duration,
    extension: entry.ext || "m4a",
  };
  if (entry.is_live)
    return { ...track, error: "Live streams cannot be downloaded." };
  const provider = providerFor(new URL(source));
  const soundcloud = provider === "SoundCloud";
  // SoundCloud lists DRM-only tracks with no formats rather than failing.
  // Those are matched on YouTube instead.
  if (soundcloud && Array.isArray(entry.formats) && !entry.formats.length)
    return {
      ...track,
      error: DRM_MESSAGE,
      matchTicket: signTicket({
        kind: "match",
        ...searchNames(track),
        origin: provider,
      }),
    };
  try {
    const found = downloadTrack(track, source);
    // DRM, removals and blocks can surface only once the stream is opened;
    // the browser then searches the other providers with these names.
    return entry.title
      ? {
          ...found,
          fallbackTicket: signTicket({
            kind: "match",
            ...searchNames(track),
            origin: provider,
          }),
        }
      : found;
  } catch {
    return { ...track, error: "This entry has no downloadable audio source." };
  }
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
  if (!info.entries)
    return {
      title: info.title || "Music",
      tracks: [catalogTrack(info, url.href)],
    };
  if (info.entries.length > MAX_TRACKS)
    throw new HttpError(422, `Import up to ${MAX_TRACKS} tracks at a time.`);
  const bandcamp = providerFor(url) === "Bandcamp";
  // Bandcamp album listings omit artists. Compilations title tracks
  // "Artist - Title"; otherwise the album's account is the artist.
  const albumArtist = bandcamp
    ? info.artist || info.uploader || info.uploader_id || ""
    : "";
  const tracks = info.entries.map((entry) => {
    let source = entry.webpage_url || entry.url || url.href;
    if (/^[a-zA-Z0-9_-]{11}$/.test(source))
      source = `https://www.youtube.com/watch?v=${source}`;
    const credited =
      bandcamp && !entry.artist && entry.title?.match(/^(.+?) - (.+)$/);
    const track = catalogTrack(
      credited
        ? { ...entry, artist: credited[1], title: credited[2], ext: "mp3" }
        : bandcamp
          ? { ...entry, ext: entry.ext || "mp3" }
          : entry,
      source,
      albumArtist,
    );
    return needsLookup(entry) && track.mediaUrl
      ? {
          ...track,
          lookupTicket: signTicket({ kind: "lookup", url: track.sourceUrl! }),
        }
      : track;
  });
  if (!tracks.length)
    throw new HttpError(422, "This link has no downloadable tracks.");
  return { title: info.title || "Music", tracks };
}
export async function lookupTrack(url: string, signal?: AbortSignal) {
  const found = await extract(url, true, signal);
  const track = catalogTrack(found, found.webpage_url || url);
  if (!track.matchTicket) return track;
  const { matchTicket: _, ...rest } = track;
  const match = await matchTrack(
    searchNames(track),
    signal,
    providerFor(new URL(found.webpage_url || url)),
  );
  return match.error
    ? { ...rest, error: `${DRM_MESSAGE} ${match.error}` }
    : { ...rest, ...match, error: undefined };
}
// Spotify supplies names, not audio, and a source can refuse its own audio
// (DRM, removal, blocks). Pick the upload most likely to be the same recording
// and say why, so the listener can verify it. Broader YouTube searches, then
// SoundCloud, run only when the narrower ones find nothing close.
export async function matchTrack(
  track: { title: string; artist: string; duration?: number },
  signal?: AbortSignal,
  origin = "Spotify",
  // Uploads that already failed to download, so the next best is chosen.
  exclude: string[] = [],
): Promise<CatalogTrack> {
  const queries = [
    `${track.artist} ${track.title} official audio`,
    `${track.artist} ${track.title}`,
    `${track.title} ${track.artist} audio`,
  ].map((q) => `ytsearch10:${q.trim().replace(/\s+/g, " ")}`);
  queries.push(`scsearch10:${track.artist} ${track.title}`.trim());
  let failed = false;
  for (const query of [...new Set(queries)]) {
    try {
      const match = await matchQuery(track, query, origin, exclude, signal);
      if (match) return match;
    } catch {
      if (signal?.aborted) break;
      failed = true;
    }
  }
  return {
    ...track,
    error: failed
      ? "Matching is temporarily unavailable. Re-import this track to try again."
      : "No close audio match found. Add a source link for this track.",
  };
}
async function matchQuery(
  track: { title: string; artist: string; duration?: number },
  query: string,
  origin: string,
  exclude: string[],
  signal?: AbortSignal,
): Promise<CatalogTrack | undefined> {
  const youtube = query.startsWith("ytsearch");
  const found = await extract(query, true, signal);
  const link = (x: Extracted) =>
    youtube
      ? /^[a-zA-Z0-9_-]{11}$/.test(x.id || "")
        ? `https://www.youtube.com/watch?v=${x.id}`
        : undefined
      : (x.webpage_url || x.url || "").match(
          /^https:\/\/(?:www\.|m\.)?soundcloud\.com\/[^/?#]+\/[^/?#]+$/,
        )?.[0];
  const artists = words(track.artist);
  const official = (x: Extracted) => {
    const channel = (x.channel || x.uploader || "").toLocaleLowerCase();
    if (/ - topic$/.test(channel)) return "the artist’s official audio channel";
    if (/vevo$/.test(channel)) return "the artist’s VEVO channel";
    if (
      artists.size &&
      [...words(channel)].filter((w) => artists.has(w)).length >=
        Math.min(2, artists.size)
    )
      return "the artist’s channel";
    return "";
  };
  const lengthMatches = (x: Extracted) =>
    Boolean(
      track.duration &&
      x.duration &&
      Math.abs(track.duration - x.duration) <=
        Math.max(3, track.duration * 0.03),
    );
  const scored = (found.entries || [])
    .filter(
      (x) =>
        !x.is_live &&
        link(x) &&
        !exclude.includes(link(x)!) &&
        // SoundCloud lists DRM-only uploads with no formats.
        !(Array.isArray(x.formats) && !x.formats.length),
    )
    .map((x) => {
      let score = matchScore(track.title, track.artist, track.duration, x);
      if (official(x)) score += 0.1;
      if (lengthMatches(x)) score += 0.1;
      else if (track.duration && x.duration) score -= 0.25;
      // Fan lyric videos and visualizers may re-edit or overlay the audio.
      if (
        /\b(?:lyrics?|visuali[sz]er)\b/i.test(x.title || "") &&
        !/\blyrics?\b/i.test(track.title)
      )
        score -= 0.1;
      // Rank unclamped so official uploads win ties at the top.
      return { x, score };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 0.58) return undefined;
  const channel = best.x.channel || best.x.uploader || "";
  const source = official(best.x);
  // A fan upload can be the right song but cannot be verified as the exact
  // release, so it is never reported as a certain match.
  const confidence = Math.min(source ? 1 : 0.75, best.score);
  const reasons = [
    ...(youtube ? [] : ["On SoundCloud"]),
    source
      ? `From ${source}`
      : `Fan upload by ${channel || "an unknown channel"}; no official upload found`,
    lengthMatches(best.x)
      ? `same length (${durationLabel(best.x.duration)})`
      : best.x.duration && track.duration
        ? `length differs: ${durationLabel(best.x.duration)} vs ${durationLabel(track.duration)} on ${origin}`
        : "length not compared",
  ];
  return downloadTrack(
    {
      ...track,
      extension: "m4a",
      matchedTitle: best.x.title,
      matchedChannel: channel,
      matchConfidence: confidence,
      matchReason: reasons.join(" · "),
      matchConfident:
        Boolean(source) && confidence >= 0.8 && lengthMatches(best.x),
    },
    link(best.x)!,
  );
}
