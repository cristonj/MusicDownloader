export type Provider =
  | "YouTube"
  | "SoundCloud"
  | "Bandcamp"
  | "Spotify"
  | "Apple Music"
  | "Amazon Music"
  | "Direct link"
  | "Local file";
export type Format =
  | "original"
  | "mp3"
  | "m4a"
  | "flac"
  | "wav"
  | "ogg"
  | "opus"
  | "aiff";
export type TrackStatus =
  | "ready"
  | "fetching"
  | "converting"
  | "done"
  | "error";
export interface Track {
  id: string;
  title: string;
  artist: string;
  provider: Provider;
  duration?: number;
  file?: File;
  mediaUrl?: string;
  transport?: "helper";
  sourceUrl?: string;
  matchedTitle?: string;
  matchConfidence?: number;
  matchedChannel?: string;
  matchReason?: string;
  // Signed names to search other providers with if the source refuses (DRM).
  fallbackTicket?: string;
  extension: string;
  selected: boolean;
  status: TrackStatus;
  progress: number;
  error?: string;
  output?: Blob;
  outputName?: string;
}
export interface Preferences {
  format: Format;
  bitrate: "128" | "192" | "256" | "320";
  sampleRate: "source" | "44100" | "48000" | "96000";
  bitDepth: "16" | "24";
}
export const defaults: Preferences = {
  format: "original",
  bitrate: "320",
  sampleRate: "source",
  bitDepth: "16",
};
export const formats: { value: Format; label: string; note: string }[] = [
  { value: "original", label: "Original", note: "Fastest · no conversion" },
  { value: "mp3", label: "MP3", note: "Plays everywhere" },
  { value: "m4a", label: "AAC", note: "Small & crisp" },
  { value: "flac", label: "FLAC", note: "Lossless" },
  { value: "wav", label: "WAV", note: "Uncompressed" },
  { value: "ogg", label: "OGG", note: "Vorbis audio" },
  { value: "opus", label: "Opus", note: "Efficient audio" },
  { value: "aiff", label: "AIFF", note: "Studio friendly" },
];
export const MAX_FILE_BYTES = 150 * 1024 * 1024;
export const MAX_BATCH_BYTES = 450 * 1024 * 1024;
// A safety ceiling on request sizes, not a product limit. Downloads are still
// bounded by MAX_BATCH_BYTES of browser memory.
export const MAX_TRACKS = 5000;
// CDN hosts the services stream audio from. SoundCloud moved its HLS audio to
// media-streaming.soundcloud.cloud; sndcdn.com still serves older tracks.
export const MEDIA_HOSTS = [
  "googlevideo.com",
  "youtube.com",
  "sndcdn.com",
  "soundcloud.com",
  "soundcloud.cloud",
  "bcbits.com",
  "bandcamp.com",
];
export const isMediaHost = (hostname: string) =>
  MEDIA_HOSTS.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );

// Services that publish track names but no downloadable audio. Their tracks
// are matched to uploads on YouTube or SoundCloud instead.
export const MATCH_PROVIDERS: Provider[] = [
  "Spotify",
  "Apple Music",
  "Amazon Music",
];
export const isMatchProvider = (provider: Provider) =>
  MATCH_PROVIDERS.includes(provider);
// Amazon Music uses one host per storefront.
export const AMAZON_MUSIC_HOSTS = [
  "com",
  "co.uk",
  "de",
  "fr",
  "it",
  "es",
  "nl",
  "se",
  "pl",
  "ca",
  "com.au",
  "com.br",
  "com.mx",
  "co.jp",
  "in",
].map((suffix) => `music.amazon.${suffix}`);

export function parseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Paste a complete https:// link.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use an HTTP or HTTPS link without credentials.");
  return url;
}
export function providerFor(url: URL): Provider {
  const host = url.hostname.toLowerCase();
  if (
    [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
    ].includes(host)
  )
    return "YouTube";
  if (host === "soundcloud.com" || host.endsWith(".soundcloud.com"))
    return "SoundCloud";
  if (host === "bandcamp.com" || host.endsWith(".bandcamp.com"))
    return "Bandcamp";
  if (host === "open.spotify.com" || host === "spotify.link") return "Spotify";
  if (["music.apple.com", "geo.music.apple.com"].includes(host))
    return "Apple Music";
  if (AMAZON_MUSIC_HOSTS.includes(host)) return "Amazon Music";
  return "Direct link";
}
export function safeFilename(name: string): string {
  const clean = name
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  const suffix = clean.match(/\.[a-z0-9]{1,5}$/i)?.[0] || "";
  const filename =
    (clean.length > 150
      ? clean.slice(0, 150 - suffix.length) + suffix
      : clean) || "Untitled";
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(filename)
    ? `_${filename}`
    : filename;
}
export function outputFilename(
  track: Pick<Track, "title" | "artist" | "extension">,
  format: Format,
): string {
  return `${safeFilename(track.artist ? `${track.artist} - ${track.title}` : track.title)}.${format === "original" ? track.extension : format}`;
}
export function extensionFor(name: string): string {
  const ext = name.split("?")[0].split(".").pop()?.toLowerCase() || "";
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : "audio";
}
export function durationLabel(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return "—";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}
export function bytesLabel(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
export function conversionArgs(prefs: Preferences): string[] {
  const codecs: Record<Exclude<Format, "original">, string[]> = {
    mp3: [
      "-c:a",
      "libmp3lame",
      "-b:a",
      `${prefs.bitrate}k`,
      "-id3v2_version",
      "3",
    ],
    m4a: [
      "-c:a",
      "aac",
      "-b:a",
      `${prefs.bitrate}k`,
      "-movflags",
      "+faststart",
    ],
    flac: [
      "-c:a",
      "flac",
      "-sample_fmt",
      prefs.bitDepth === "24" ? "s32" : "s16",
      "-compression_level",
      "5",
    ],
    wav: ["-c:a", prefs.bitDepth === "24" ? "pcm_s24le" : "pcm_s16le"],
    ogg: ["-c:a", "libvorbis", "-b:a", `${prefs.bitrate}k`, "-ac", "2"],
    // The pinned WASM core traps in libopus stereo encoding; the native
    // FFmpeg Opus encoder supports these settings without that memory fault.
    opus: [
      "-c:a",
      "opus",
      "-strict",
      "-2",
      "-b:a",
      `${prefs.bitrate}k`,
      "-ac",
      "2",
      "-ar",
      "48000",
    ],
    aiff: ["-c:a", prefs.bitDepth === "24" ? "pcm_s24be" : "pcm_s16be"],
  };
  if (prefs.format === "original") return [];
  return [
    "-map",
    "0:a:0",
    "-vn",
    ...codecs[prefs.format],
    ...(prefs.sampleRate !== "source" && prefs.format !== "opus"
      ? ["-ar", prefs.sampleRate]
      : []),
  ];
}
export function isLossless(format: Format) {
  return ["flac", "wav", "aiff"].includes(format);
}
export function readPreferences(value: string | null): Preferences {
  try {
    const p = JSON.parse(value || "{}");
    return {
      format: formats.some((f) => f.value === p.format)
        ? p.format
        : defaults.format,
      bitrate: ["128", "192", "256", "320"].includes(p.bitrate)
        ? p.bitrate
        : defaults.bitrate,
      sampleRate: ["source", "44100", "48000", "96000"].includes(p.sampleRate)
        ? p.sampleRate
        : defaults.sampleRate,
      bitDepth: ["16", "24"].includes(p.bitDepth)
        ? p.bitDepth
        : defaults.bitDepth,
    };
  } catch {
    return defaults;
  }
}
