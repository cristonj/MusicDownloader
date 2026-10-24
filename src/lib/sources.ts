import {
  extensionFor,
  MAX_FILE_BYTES,
  MAX_TRACKS,
  parseUrl,
  providerFor,
  type Track,
} from "./model";

export class ResolverRequiredError extends Error {}
export function resolverBase(value: string): string {
  const url = parseUrl(value);
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("Resolver must use HTTPS, or localhost for development.");
  if (url.search || url.hash)
    throw new Error("Use a resolver URL without a query or fragment.");
  return url.href.replace(/\/$/, "");
}
export function localTrack(file: File): Track {
  if (file.size > MAX_FILE_BYTES)
    throw new Error(`${file.name} is over the 150 MB per-track limit.`);
  if (
    !file.type.startsWith("audio/") &&
    !/\.(mp3|wav|flac|m4a|aac|ogg|opus|aiff?|webm|mp4)$/i.test(file.name)
  )
    throw new Error(`${file.name} is not a supported audio file.`);
  return {
    id: crypto.randomUUID(),
    title: file.name.replace(/\.[^.]+$/, ""),
    artist: "",
    provider: "Local file",
    file,
    extension: extensionFor(file.name),
    selected: true,
    status: "ready",
    progress: 0,
  };
}
export async function resolveLink(
  input: string,
  resolver: string,
  signal: AbortSignal,
): Promise<{ title: string; tracks: Track[] }> {
  const url = parseUrl(input);
  const provider = providerFor(url);
  if (provider === "Direct link") {
    const filename = decodeURIComponent(
      url.pathname.split("/").pop() || "Audio",
    );
    if (!/\.(mp3|wav|flac|m4a|aac|ogg|opus|aiff?|webm|mp4)$/i.test(filename))
      throw new Error(
        "Use a supported music service or a direct audio file link.",
      );
    return {
      title: filename.replace(/\.[^.]+$/, ""),
      tracks: [
        {
          id: crypto.randomUUID(),
          title: filename.replace(/\.[^.]+$/, ""),
          artist: "",
          provider,
          mediaUrl: url.href,
          extension: extensionFor(filename),
          selected: true,
          status: "ready",
          progress: 0,
        },
      ],
    };
  }
  if (!resolver)
    throw new ResolverRequiredError(
      "Connect a resolver to import service links. Local files and direct audio links work without one.",
    );
  const base = resolverBase(resolver);
  const response = await fetch(`${base}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: url.href }),
    signal,
    credentials: "omit",
  });
  const result = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      typeof result?.detail === "string"
        ? result.detail
        : "The source could not be opened. Try again or import a file.",
    );
  if (!result || !Array.isArray(result.tracks) || !result.tracks.length)
    throw new Error("This link has no downloadable tracks.");
  if (result.tracks.length > MAX_TRACKS)
    throw new Error(`Import up to ${MAX_TRACKS} tracks at a time.`);
  const tracks: Track[] = result.tracks.map((item: Record<string, unknown>) => {
    if (
      typeof item.title !== "string" ||
      (typeof item.mediaUrl !== "string" && typeof item.error !== "string")
    )
      throw new Error("The resolver returned an invalid track.");
    const media =
      typeof item.mediaUrl === "string"
        ? parseUrl(new URL(item.mediaUrl, `${base}/`).href)
        : undefined;
    if (
      media &&
      media.protocol !== "https:" &&
      media.origin !== new URL(base).origin
    )
      throw new Error("The resolver returned an insecure media URL.");
    return {
      id: crypto.randomUUID(),
      title: item.title.slice(0, 300),
      artist: typeof item.artist === "string" ? item.artist.slice(0, 200) : "",
      duration: typeof item.duration === "number" ? item.duration : undefined,
      provider,
      mediaUrl: media?.href,
      extension:
        typeof item.extension === "string" &&
        /^[a-z0-9]{1,5}$/.test(item.extension)
          ? item.extension
          : "webm",
      sourceUrl:
        typeof item.sourceUrl === "string" &&
        providerFor(parseUrl(item.sourceUrl)) === "YouTube"
          ? item.sourceUrl
          : undefined,
      matchedTitle:
        typeof item.matchedTitle === "string"
          ? item.matchedTitle.slice(0, 300)
          : undefined,
      matchConfidence:
        typeof item.matchConfidence === "number"
          ? item.matchConfidence
          : undefined,
      selected: provider !== "Spotify" && !item.error,
      status: item.error ? "error" : "ready",
      error: typeof item.error === "string" ? item.error : undefined,
      progress: 0,
    };
  });
  return {
    title:
      typeof result.title === "string" ? result.title.slice(0, 300) : provider,
    tracks,
  };
}
export async function fetchAudio(
  track: Track,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<{ blob: Blob; extension: string }> {
  if (track.file) return { blob: track.file, extension: track.extension };
  if (!track.mediaUrl)
    throw new Error(
      track.error || "This track has no downloadable audio source.",
    );
  const response = await fetch(track.mediaUrl!, {
    signal,
    credentials: "omit",
  }).catch((error) => {
    if (signal.aborted) throw error;
    throw new Error(
      "The audio could not be fetched. Direct links must allow browser access (CORS); service links may need re-importing.",
    );
  });
  if (!response.ok)
    throw new Error(
      response.status === 410
        ? "This link expired. Remove it and import the source again."
        : `Source returned ${response.status}. Re-import the link or try a local file.`,
    );
  const mime = response.headers.get("content-type") || "";
  if (/text\/|application\/(json|xml)/.test(mime))
    throw new Error("This link returned a page instead of audio.");
  const total = Number(response.headers.get("content-length")) || 0;
  if (total > MAX_FILE_BYTES)
    throw new Error("This track exceeds the 150 MB browser limit.");
  if (!response.body) throw new Error("This source did not return audio.");
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_FILE_BYTES)
        throw new Error("This track exceeds the 150 MB browser limit.");
      chunks.push(value);
      onProgress(
        total ? received / total : Math.min(0.9, received / MAX_FILE_BYTES),
      );
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (!received) throw new Error("The source returned an empty file.");
  const ext = response.headers.get("X-Audio-Extension");
  const mimeExtensions: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp4": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/flac": "flac",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "video/webm": "webm",
    "audio/aac": "aac",
    "audio/aiff": "aiff",
  };
  return {
    blob: new Blob(chunks, { type: mime || "application/octet-stream" }),
    extension:
      ext && /^[a-z0-9]{1,5}$/.test(ext)
        ? ext
        : mimeExtensions[mime.split(";")[0]] || track.extension,
  };
}
