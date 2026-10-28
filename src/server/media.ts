import {
  extract,
  extractUsingClient,
  invalidateExtraction,
  rememberExtraction,
  type Extracted,
} from "./extractor";
import {
  allowedMedia,
  HttpError,
  signTicket,
  type MediaTicket,
} from "./security";
import { mediaFetch } from "./upstream";
export const CHUNK_BYTES = 2 * 1024 * 1024;
export interface AudioManifest {
  extension: string;
  remuxTo?: string;
  parts: string[];
}
const proxy = (
  url: string,
  headers: Record<string, string>,
  range?: [number, number],
) => {
  allowedMedia(url);
  return `/api/media?ticket=${signTicket({ kind: "media", url, headers, ...(range ? { range } : {}) })}`;
};
export function sourceHeaders(value?: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([key]) =>
      ["user-agent", "referer", "origin", "accept", "accept-language"].includes(
        key.toLowerCase(),
      ),
    ),
  );
}
async function playlist(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
) {
  const response = await mediaFetch(url, headers, signal);
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024 || !text.trimStart().startsWith("#EXTM3U"))
    throw new HttpError(422, "The audio playlist is invalid.");
  return text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}
export async function hlsManifest(
  url: string,
  headers: Record<string, string>,
  codec = "aac",
  signal?: AbortSignal,
): Promise<AudioManifest> {
  let base = url,
    lines = await playlist(url, headers, signal);
  if (lines.some((line) => line.startsWith("#EXT-X-STREAM-INF:"))) {
    const variants: { url: string; bandwidth: number }[] = [];
    for (let i = 0; i < lines.length; i++)
      if (
        lines[i].startsWith("#EXT-X-STREAM-INF:") &&
        lines[i + 1] &&
        !lines[i + 1].startsWith("#")
      )
        variants.push({
          url: new URL(lines[i + 1], base).href,
          bandwidth: Number(lines[i].match(/(?:^|,)BANDWIDTH=(\d+)/)?.[1] || 0),
        });
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    if (!variants[0]) throw new HttpError(422, "No audio stream was found.");
    base = allowedMedia(variants[0].url).href;
    lines = await playlist(base, headers, signal);
  }
  if (
    lines.some(
      (line) => line.startsWith("#EXT-X-KEY:") && !line.includes("METHOD=NONE"),
    )
  )
    throw new HttpError(
      422,
      "This source uses an encrypted stream. Import your original file.",
    );
  if (!lines.includes("#EXT-X-ENDLIST"))
    throw new HttpError(422, "Live audio streams cannot be downloaded.");
  const parts: string[] = [];
  let nextRange: [number, number] | undefined,
    offset = 0;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-MAP:")) {
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      const range = line.match(/BYTERANGE="(\d+)(?:@(\d+))?"/);
      if (uri)
        parts.push(
          proxy(
            new URL(uri, base).href,
            headers,
            range
              ? [
                  Number(range[2] || 0),
                  Number(range[2] || 0) + Number(range[1]) - 1,
                ]
              : undefined,
          ),
        );
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const range = line.slice(17).match(/^(\d+)(?:@(\d+))?$/);
      if (!range) throw new HttpError(422, "Invalid audio segment range.");
      const start = range[2] ? Number(range[2]) : offset;
      nextRange = [start, start + Number(range[1]) - 1];
      offset = nextRange[1] + 1;
    } else if (!line.startsWith("#")) {
      parts.push(proxy(new URL(line, base).href, headers, nextRange));
      nextRange = undefined;
    }
    if (parts.length > 3000)
      throw new HttpError(422, "This track has too many audio segments.");
  }
  if (!parts.length) throw new HttpError(422, "No audio segments were found.");
  return {
    extension: lines.some((line) => line.startsWith("#EXT-X-MAP:"))
      ? "mp4"
      : "ts",
    remuxTo: audioExtension(codec),
    parts,
  };
}
function audioExtension(codec = "aac"): string {
  return /mp3/.test(codec)
    ? "mp3"
    : /opus/.test(codec)
      ? "opus"
      : /vorbis/.test(codec)
        ? "ogg"
        : "m4a";
}
async function playableManifest(
  info: Extracted,
  signal?: AbortSignal,
): Promise<AudioManifest> {
  if (info.is_live)
    throw new HttpError(422, "Live streams cannot be downloaded.");
  if (!info.url) throw new HttpError(422, "No audio source was found.");
  const headers = sourceHeaders(info.http_headers);
  let manifest: AudioManifest;
  if (
    info.protocol?.includes("m3u8") ||
    new URL(info.url).pathname.endsWith(".m3u8")
  ) {
    manifest = await hlsManifest(info.url, headers, info.acodec, signal);
  } else if (info.protocol === "http_dash_segments" && info.fragments?.length) {
    if (info.fragments.length > 3000)
      throw new HttpError(422, "This track has too many audio segments.");
    manifest = {
      extension: info.ext || "m4a",
      remuxTo: audioExtension(info.acodec),
      parts: info.fragments.map((fragment) => {
        const url = new URL(
          fragment.url || fragment.path || "",
          info.fragment_base_url || info.url,
        ).href;
        const range = fragment.range?.match(/^(\d+)-(\d+)$/);
        return proxy(
          url,
          headers,
          range ? [Number(range[1]), Number(range[2])] : undefined,
        );
      }),
    };
  } else {
    if (info.protocol && !["http", "https"].includes(info.protocol))
      throw new HttpError(422, "This audio stream is not supported.");
    manifest = {
      extension: /^[a-z0-9]{1,5}$/.test(info.ext || "") ? info.ext! : "m4a",
      // A combined playback file can still provide the original audio losslessly.
      ...(info.vcodec && info.vcodec !== "none"
        ? { remuxTo: audioExtension(info.acodec) }
        : {}),
      parts: [proxy(info.url, headers)],
    };
  }
  // Metadata can describe streams the CDN subsequently rejects. Probe a byte
  // before choosing a candidate so fallback clients cover real stream failures.
  const first = new URL(
    manifest.parts[0],
    "https://internal.invalid",
  ).searchParams.get("ticket")!;
  const { readTicket } = await import("./security");
  const ticket = readTicket(first, "media");
  const response = await mediaFetch(
    ticket.url,
    {
      ...ticket.headers,
      Range: `bytes=${ticket.range?.[0] || 0}-${ticket.range?.[0] || 0}`,
    },
    signal,
  );
  const mime = response.headers.get("content-type") || "";
  await response.body?.cancel();
  if (/text\/|application\/(json|xml)/i.test(mime))
    throw new HttpError(422, "The source returned a page instead of audio.");
  return manifest;
}
export async function audioManifest(
  url: string,
  signal?: AbortSignal,
): Promise<AudioManifest> {
  const info = await extract(url, false, signal);
  try {
    return await playableManifest(info, signal);
  } catch (error) {
    const host = new URL(url).hostname;
    const youtube = [
      "youtube.com",
      "www.youtube.com",
      "music.youtube.com",
      "m.youtube.com",
      "youtu.be",
    ].includes(host);
    if (
      !youtube &&
      !signal?.aborted &&
      error instanceof HttpError &&
      error.status === 410
    ) {
      // The cached extraction holds an expired signed link; extract afresh.
      invalidateExtraction(url);
      return playableManifest(await extract(url, false, signal), signal);
    }
    if (
      !youtube ||
      signal?.aborted ||
      !(error instanceof HttpError) ||
      error.status === 413 ||
      /Live streams/.test(error.message)
    )
      throw error;
    invalidateExtraction(url);
    const stop = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, stop.signal])
      : stop.signal;
    try {
      return await Promise.any(
        (["web_embedded", "web_safari"] as const).map(async (client) => {
          const candidate = await extractUsingClient(url, client, combined);
          const manifest = await playableManifest(candidate, combined);
          rememberExtraction(url, candidate);
          return manifest;
        }),
      );
    } catch {
      if (signal?.aborted) throw new HttpError(499, "Download cancelled.");
      throw new HttpError(
        503,
        "YouTube rejected the available download streams from this server. Please try again later.",
      );
    } finally {
      stop.abort();
    }
  }
}
export async function mediaChunk(
  ticket: MediaTicket,
  range: string | null,
  signal?: AbortSignal,
) {
  const match = range?.match(/^bytes=(\d+)-(\d+)$/);
  if (range && !match) throw new HttpError(416, "Invalid audio range.");
  const start = match ? Number(match[1]) : 0;
  const end = Math.min(
    match ? Number(match[2]) : CHUNK_BYTES - 1,
    start + CHUNK_BYTES - 1,
  );
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(end) ||
    end < start
  )
    throw new HttpError(416, "Invalid audio range.");
  const base = ticket.range?.[0] || 0;
  const requestedEnd = Math.min(
    base + end,
    ticket.range?.[1] ?? Number.MAX_SAFE_INTEGER,
  );
  if (base + start > requestedEnd)
    throw new HttpError(416, "Audio range is complete.");
  const upstream = await mediaFetch(
    ticket.url,
    { ...ticket.headers, Range: `bytes=${base + start}-${requestedEnd}` },
    signal,
  );
  const contentType =
    upstream.headers.get("content-type") || "application/octet-stream";
  if (/text\/|application\/(json|xml|vnd\.apple\.mpegurl)/i.test(contentType)) {
    await upstream.body?.cancel();
    throw new HttpError(422, "The source returned a page instead of audio.");
  }
  const cr = upstream.headers
    .get("content-range")
    ?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/i);
  if (upstream.status === 206 && (!cr || Number(cr[1]) !== base + start)) {
    await upstream.body?.cancel();
    throw new HttpError(502, "The source returned an invalid audio range.");
  }
  const fullLength =
    cr && cr[3] !== "*"
      ? Number(cr[3])
      : upstream.status === 200
        ? Number(upstream.headers.get("content-length")) || undefined
        : undefined;
  const total = ticket.range
    ? ticket.range[1] - ticket.range[0] + 1
    : fullLength;
  const reader = upstream.body?.getReader();
  if (!reader) throw new HttpError(502, "No audio was returned.");
  const chunks: Uint8Array[] = [];
  let skip = upstream.status === 200 ? base + start : 0,
    size = 0,
    reachedEnd = false;
  const wanted = requestedEnd - (base + start) + 1;
  try {
    while (size < wanted + 1) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEnd = true;
        break;
      }
      if (skip >= value.length) {
        skip -= value.length;
        continue;
      }
      const chunk = value.subarray(
        skip,
        skip + Math.min(value.length - skip, wanted + 1 - size),
      );
      skip = 0;
      chunks.push(chunk);
      size += chunk.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const body = Buffer.concat(chunks).subarray(0, wanted);
  if (!body.length) throw new HttpError(416, "No more audio was returned.");
  const last = start + body.length - 1;
  const more = total
    ? last + 1 < total
    : cr
      ? Number(cr[2]) >= base + end
      : !reachedEnd || size > wanted;
  return { body, contentType, start, end: last, total, more };
}
