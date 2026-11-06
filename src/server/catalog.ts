import {
  durationLabel,
  isArtworkUrl,
  MAX_TRACKS,
  providerFor,
} from "@/lib/model";
import { appleMusicMetadata } from "./apple";
import { amazonMusicMetadata } from "./amazon";
import { allowedSource, HttpError, signTicket } from "./security";
import { extract, type Extracted } from "./extractor";
import { spotifyMetadata } from "./spotify";
import { artistOffer, discoverSet, isDiscoverSet } from "./soundcloud";
export interface CatalogTrack {
  title: string;
  // The upload's own title, when a shorter song name is shown instead.
  fullTitle?: string;
  artist: string;
  duration?: number;
  artwork?: string;
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
  originalDownload?: boolean;
  artistLink?: { url: string; label: string };
}
// The services publish cover art with their listings. A square-ish image of
// about 300px reads well in the feed without pulling a needless full-size one.
export function artworkFor(entry: Extracted): string | undefined {
  if (/^[a-zA-Z0-9_-]{11}$/.test(entry.id || ""))
    return `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`;
  const sized = (entry.thumbnails || []).filter(
    (thumb) => thumb.url && isArtworkUrl(thumb.url),
  );
  const best =
    sized
      .filter((thumb) => (thumb.width || 0) >= 200 && (thumb.width || 0) <= 800)
      .sort((a, b) => (a.width || 0) - (b.width || 0))[0] ||
    sized.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  const found = best?.url || entry.thumbnail;
  return found && isArtworkUrl(found) ? found : undefined;
}
// Upload titles carry promotion a song name does not: format tags, credit
// chains, and the artist repeated ahead of a dash. The feed shows the song,
// and keeps the upload's own title for the listener to check.
const TAGS =
  /\s*[([]\s*(?:official\s*)?(?:music\s*)?(?:video|audio|visuali[sz]er|lyrics?(?:\s*video)?|mv|hd|4k|full\s*(?:video|song)|video\s*song)\s*[)\]]/gi;
// The same words also appear unbracketed at the end of an upload's title.
const TRAILING_TAG =
  /\s*[-–—|·]?\s*\b(?:official\s+)?(?:music\s+)?(?:video|audio|visuali[sz]er|lyrics?(?:\s+video)?|mv|full\s+(?:video|song)|video\s+song)\b\s*$/i;
// A name that is only a format tag is not a song name.
const TAG_ONLY =
  /^(?:(?:official\s+)?(?:music\s+)?(?:video|audio|visuali[sz]er|lyrics?(?:\s+video)?|mv|full\s+(?:video|song)|video\s+song)|hd|4k)$/i;
const tidy = (value: string) =>
  value
    .replace(TAGS, " ")
    .replace(/\s+/g, " ")
    .replace(TRAILING_TAG, "")
    .replace(/[\s|,·-]+$/, "")
    .trim();
const words = (s: string) =>
  new Set(s.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
const sameName = (a: string, b: string) => {
  const left = words(a),
    right = words(b);
  return (
    left.size > 0 &&
    left.size === right.size &&
    [...left].every((x) => right.has(x))
  );
};
export function songName(title: string, artist: string) {
  let name = tidy(title);
  const segments = name.split(/\s*\|\s*/).filter(Boolean);
  // Pipes separate a name from its credits: three segments is a chain, and
  // two is one too, once the first is long enough to be the name itself.
  if (
    (segments.length >= 3 && segments[0].length >= 3) ||
    (segments.length === 2 && segments[0].length >= 10)
  )
    name = tidy(segments[0]);
  const credited = name.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (credited) {
    const song = tidy(credited[2]);
    const before = tidy(credited[1]);
    // "Song - Artist", when the uploader's own name follows the dash.
    if (
      before.length >= 2 &&
      sameName(song, artist) &&
      !sameName(before, artist)
    )
      return { title: before, artist: song };
    // "Artist - Song", unless what follows the dash was only a format tag.
    if (song.length >= 2 && !TAG_ONLY.test(song))
      return { title: song, artist: tidy(credited[1]) || artist };
    const left = tidy(credited[1]);
    if (left.length >= 2) return { title: left, artist };
  }
  return { title: name || title, artist };
}
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
    // Karaoke labels list guide-vocal and restyled takes under the song's name.
    "vocal",
    "metal",
    "tribute",
  ])
    if (found.has(version) !== target.has(version)) score -= 0.3;
  if (
    /karaoke|tribute|party tyme|sing king/i.test(
      `${candidate.channel || ""} ${candidate.uploader || ""}`,
    ) &&
    !/karaoke|tribute/i.test(`${title} ${artist}`)
  )
    score -= 0.4;
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
  return { ...songName(track.title, track.artist), duration: track.duration };
}
export function catalogTrack(
  entry: Extracted,
  source: string,
  albumArtist = "",
): CatalogTrack {
  const track: CatalogTrack = {
    title: entry.track || entry.title || "Untitled",
    artist:
      entry.artist || entry.uploader || entry.channel || albumArtist || "",
    duration: entry.duration,
    artwork: artworkFor(entry),
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
  const provider = providerFor(url);
  // Spotify, Apple Music, and Amazon Music publish names, not audio. Each
  // track carries a signed ticket the browser redeems for a YouTube match.
  const metadata =
    provider === "Spotify"
      ? spotifyMetadata
      : provider === "Apple Music"
        ? appleMusicMetadata
        : provider === "Amazon Music"
          ? amazonMusicMetadata
          : undefined;
  if (metadata) {
    const result = await metadata(url.href);
    return {
      ...result,
      tracks: result.tracks.map((track) => ({
        ...track,
        matchTicket: signTicket({ kind: "match", ...track, origin: provider }),
      })),
    };
  }
  // Discover sets have no set page yt-dlp can extract.
  if (provider === "SoundCloud" && isDiscoverSet(url))
    return discoverSet(url.href, MAX_TRACKS, signal);
  const info = await extract(url.href, true, signal);
  if (!info.entries)
    return {
      title: info.title || "Music",
      tracks: [
        {
          ...catalogTrack(info, url.href),
          ...(provider === "SoundCloud"
            ? await artistOffer(info.webpage_url || url.href, signal)
            : {}),
        },
      ],
    };
  if (info.entries.length > MAX_TRACKS)
    throw new HttpError(422, `Import up to ${MAX_TRACKS} tracks at a time.`);
  const bandcamp = provider === "Bandcamp";
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
  // The browser searches again with these names if the matched upload fails.
  const { matchTicket: fallbackTicket, ...rest } = track;
  const match = await matchTrack(
    searchNames(track),
    signal,
    providerFor(new URL(found.webpage_url || url)),
  );
  return match.error
    ? { ...rest, error: `${DRM_MESSAGE} ${match.error}` }
    : { ...rest, ...match, fallbackTicket, error: undefined };
}
// Spotify supplies names, not audio, and a source can refuse its own audio
// (DRM, removal, blocks). Pick the upload most likely to be the same recording
// and say why, so the listener can verify it. YouTube Music's song listings come
// first: they carry the released recording, where a general search favours the
// music video's own edit. A fan upload never ends the search early, and
// SoundCloud runs only when YouTube has nothing close.
const MUSIC_SEARCH = "music";
const MATCH_BUDGET_MS = 30000;
// Spotify appends a remaster note that other services' listings word differently
// or leave out, and its words would otherwise fail the title comparison.
const REMASTER_NOTE =
  /\s+-\s+(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?remaster(?:ed)?(?:\s+(?:version|\d{4}))?\s*$/i;
export async function matchTrack(
  track: { title: string; artist: string; duration?: number },
  signal?: AbortSignal,
  origin = "Spotify",
  // Uploads that already failed to download, so the next best is chosen.
  exclude: string[] = [],
): Promise<CatalogTrack> {
  const title = track.title.replace(REMASTER_NOTE, "") || track.title;
  const named = { ...track, title };
  const queries = [
    `${track.artist} ${title} official audio`,
    `${track.artist} ${title}`,
    `${title} ${track.artist} audio`,
    // Re-uploaders often post under their own name rather than the artist's.
    title,
  ].map((q) => `ytsearch10:${q.trim().replace(/\s+/g, " ")}`);
  queries.unshift(MUSIC_SEARCH);
  queries.push(`scsearch10:${track.artist} ${title}`.trim());
  const started = Date.now();
  let failed = false,
    best: CatalogTrack | undefined;
  for (const query of [...new Set(queries)]) {
    if (
      best &&
      (query.startsWith("scsearch") || Date.now() - started > MATCH_BUDGET_MS)
    )
      break;
    try {
      const found = await matchQuery(named, query, origin, exclude, signal);
      const match = found && { ...found, title: track.title };
      if (match?.matchConfident) return match;
      if (match && (match.matchConfidence || 0) > (best?.matchConfidence || 0))
        best = match;
    } catch {
      if (signal?.aborted) break;
      failed = true;
    }
  }
  if (best) return best;
  return {
    ...track,
    error: failed
      ? "Matching is temporarily unavailable. Re-import this track to try again."
      : "No close audio match found. Add a source link for this track.",
  };
}
// Song listings name only the title, so the closest few are read in full for
// their channel, length, and audio formats.
async function musicListing(
  track: { title: string; artist: string },
  signal?: AbortSignal,
) {
  const search = `${track.artist} ${track.title}`.trim();
  const found = await extract(
    `https://music.youtube.com/search?q=${encodeURIComponent(search)}#songs`,
    true,
    signal,
  );
  const target = words(track.title);
  return (found.entries || [])
    .filter((x) => {
      const title = words(x.title || "");
      return (
        /^[a-zA-Z0-9_-]{11}$/.test(x.id || "") &&
        [...target].filter((word) => title.has(word)).length >=
          target.size * 0.65
      );
    })
    .slice(0, 3);
}
async function musicCandidates(
  track: { title: string; artist: string },
  signal?: AbortSignal,
): Promise<Extracted[]> {
  const closest = await musicListing(track, signal);
  const full = await Promise.allSettled(
    closest.map((x) =>
      extract(`https://www.youtube.com/watch?v=${x.id}`, false, signal),
    ),
  );
  return full.flatMap((x) => (x.status === "fulfilled" ? [x.value] : []));
}
type MatchTarget = { title: string; artist: string; duration?: number };
const lengthMatches = (track: MatchTarget, x: Extracted) =>
  Boolean(
    track.duration &&
    x.duration &&
    Math.abs(track.duration - x.duration) <= Math.max(3, track.duration * 0.03),
  );
// Scores uploads as candidates for one recording, most likely first.
function rankUploads(
  track: MatchTarget,
  entries: Extracted[],
  youtube: boolean,
  exclude: string[] = [],
) {
  const link = (x: Extracted) =>
    youtube
      ? /^[a-zA-Z0-9_-]{11}$/.test(x.id || "")
        ? `https://www.youtube.com/watch?v=${x.id}`
        : undefined
      : (x.webpage_url || x.url || "").match(
          /^https:\/\/(?:www\.|m\.)?soundcloud\.com\/[^/?#]+\/[^/?#]+$/,
        )?.[0];
  const artists = words(track.artist);
  // Topic and VEVO channels exist for every release, including covers of this
  // song, so one counts only when it belongs to a credited artist.
  const credited = track.artist
    .split(/\s*(?:,|&|\bfeat\.?|\bft\.?|\bx\b)\s*/i)
    .map(words)
    .filter((name) => name.size);
  const official = (x: Extracted) => {
    const channel = (x.channel || x.uploader || "").toLocaleLowerCase();
    const theirs =
      !credited.length ||
      credited.some((name) => [...name].every((w) => channel.includes(w)));
    if (/ - topic$/.test(channel))
      return theirs ? "the artist’s official audio channel" : "";
    if (/vevo$/.test(channel)) return theirs ? "the artist’s VEVO channel" : "";
    if (credited.some((name) => sameName([...name].join(" "), channel)))
      return "the artist’s channel";
    if (
      artists.size &&
      [...words(channel)].filter((w) => artists.has(w)).length >=
        Math.min(2, artists.size)
    )
      return "the artist’s channel";
    return "";
  };
  return entries
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
      if (lengthMatches(track, x)) score += 0.1;
      else if (track.duration && x.duration) score -= 0.25;
      // Fan lyric videos and visualizers may re-edit or overlay the audio.
      if (
        /\b(?:lyrics?|visuali[sz]er)\b/i.test(x.title || "") &&
        !/\blyrics?\b/i.test(track.title)
      )
        score -= 0.1;
      // Rank unclamped so official uploads win ties at the top.
      return { x, score, link: link(x)!, source: official(x) };
    })
    // Equally likely recordings are separated by the audio they offer.
    .sort((a, b) => b.score - a.score || (b.x.abr || 0) - (a.x.abr || 0));
}
function describeMatch(
  track: MatchTarget,
  best: ReturnType<typeof rankUploads>[number],
  youtube: boolean,
  origin: string,
): CatalogTrack {
  const channel = best.x.channel || best.x.uploader || "";
  // A fan upload can be the right song but cannot be verified as the exact
  // release, so it is never reported as a certain match.
  const confidence = Math.min(best.source ? 1 : 0.75, best.score);
  const reasons = [
    ...(youtube ? [] : ["On SoundCloud"]),
    best.source
      ? `From ${best.source}`
      : `Fan upload by ${channel || "an unknown channel"}; no official upload found`,
    lengthMatches(track, best.x)
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
        Boolean(best.source) &&
        confidence >= 0.8 &&
        lengthMatches(track, best.x),
    },
    best.link,
  );
}
async function matchQuery(
  track: MatchTarget,
  query: string,
  origin: string,
  exclude: string[],
  signal?: AbortSignal,
): Promise<CatalogTrack | undefined> {
  const youtube = !query.startsWith("scsearch");
  if (query === MUSIC_SEARCH) {
    // Each read takes seconds, so the top listing is read alone first. A certain
    // match there needs no comparison with the rest.
    const [first, ...rest] = await musicListing(track, signal);
    if (!first) return undefined;
    const read = (x: Extracted) =>
      extract(`https://www.youtube.com/watch?v=${x.id}`, false, signal);
    const lead = await read(first).catch(() => undefined);
    const top = lead && rankUploads(track, [lead], true, exclude)[0];
    const quick = top && describeMatch(track, top, true, origin);
    if (top && top.score >= 0.58 && quick?.matchConfident) return quick;
    const others = await Promise.allSettled(rest.map(read));
    const best = rankUploads(
      track,
      [
        ...(lead ? [lead] : []),
        ...others.flatMap((x) => (x.status === "fulfilled" ? [x.value] : [])),
      ],
      true,
      exclude,
    )[0];
    return best && best.score >= 0.58
      ? describeMatch(track, best, true, origin)
      : undefined;
  }
  const entries = (await extract(query, true, signal)).entries;
  const best = rankUploads(track, entries || [], youtube, exclude)[0];
  if (!best || best.score < 0.58) return undefined;
  return describeMatch(track, best, youtube, origin);
}
export interface SourceOption extends CatalogTrack {
  provider: "YouTube" | "SoundCloud";
  codec?: string;
  bitrateKbps?: number;
  sampleRate?: number;
  channels?: number;
}
const OPTION_FLOOR = 0.4;
// Every upload worth considering for one track, read in full so each shows the
// audio it really offers. An upload that cannot be read is not offered at all.
export async function sourceOptions(
  track: MatchTarget,
  origin = "Spotify",
  signal?: AbortSignal,
): Promise<SourceOption[]> {
  const title = track.title.replace(REMASTER_NOTE, "") || track.title;
  const named = { ...track, title };
  const search = `${track.artist} ${title}`.trim().replace(/\s+/g, " ");
  const [music, video, cloud] = await Promise.allSettled([
    musicCandidates(named, signal),
    extract(`ytsearch6:${search}`, true, signal),
    extract(`scsearch4:${search}`, true, signal),
  ]);
  const unique = (items: ReturnType<typeof rankUploads>, count: number) =>
    items
      .filter(
        (item, index) =>
          item.score >= OPTION_FLOOR &&
          items.findIndex((other) => other.link === item.link) === index,
      )
      .slice(0, count);
  const picks = [
    ...unique(
      rankUploads(
        named,
        [
          ...(music.status === "fulfilled" ? music.value : []),
          ...(video.status === "fulfilled" ? video.value.entries || [] : []),
        ],
        true,
      ),
      4,
    ).map((item) => ({ item, youtube: true })),
    ...unique(
      rankUploads(
        named,
        cloud.status === "fulfilled" ? cloud.value.entries || [] : [],
        false,
      ),
      2,
    ).map((item) => ({ item, youtube: false })),
  ];
  const read = await Promise.allSettled(
    picks.map(async ({ item, youtube }): Promise<SourceOption> => {
      const full = await extract(item.link, false, signal);
      if (Array.isArray(full.formats) && !full.formats.length)
        throw new Error("No playable audio.");
      return {
        ...describeMatch(
          track,
          { ...item, x: { ...item.x, ...full } },
          youtube,
          origin,
        ),
        provider: youtube ? "YouTube" : "SoundCloud",
        extension: full.ext || "m4a",
        codec: full.acodec && full.acodec !== "none" ? full.acodec : undefined,
        bitrateKbps: full.abr || full.tbr || undefined,
        sampleRate: full.asr || undefined,
        channels: full.audio_channels || undefined,
        ...(youtube ? {} : await artistOffer(item.link, signal)),
      };
    }),
  );
  return read.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
}
// Search results list uploads that are already downloadable, so the feed
// shows them with the same audio tickets an imported link would carry.
export function searchResults(
  entries: Extracted[],
  youtube: boolean,
  limit: number,
): CatalogTrack[] {
  const tracks: CatalogTrack[] = [];
  for (const entry of entries) {
    if (tracks.length >= limit) break;
    const source = youtube
      ? /^[a-zA-Z0-9_-]{11}$/.test(entry.id || "")
        ? `https://www.youtube.com/watch?v=${entry.id}`
        : ""
      : (entry.webpage_url || entry.url || "").match(
          /^https:\/\/(?:www\.|m\.)?soundcloud\.com\/[^/?#]+\/[^/?#]+$/,
        )?.[0] || "";
    if (!source || entry.is_live || !entry.title) continue;
    const track = catalogTrack(entry, source);
    if (track.mediaUrl || track.matchTicket) tracks.push(track);
  }
  return tracks;
}
