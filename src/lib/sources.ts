import { helperConnection, HelperRequiredError, sourceFetch } from "./helper";
import {
  extensionFor,
  MAX_FILE_BYTES,
  MAX_TRACKS,
  parseUrl,
  providerFor,
  type Track,
} from "./model";

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
  const transport = helperConnection() ? ("helper" as const) : undefined;
  const response = await sourceFetch(
    "/api/resolve",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.href }),
      signal,
    },
    transport,
  );
  const result = await response.json().catch(() => null);
  if (
    !response.ok &&
    !transport &&
    /web server|from this server|blocking requests|download engine/i.test(
      result?.detail || "",
    )
  )
    throw new HelperRequiredError(
      "Connect the desktop helper to open this link from your computer.",
    );
  if (!response.ok)
    throw new Error(
      result?.detail || "This source could not be opened. Try another link.",
    );
  if (!result || !Array.isArray(result.tracks) || !result.tracks.length)
    throw new Error("This link has no downloadable tracks.");
  if (result.tracks.length > MAX_TRACKS)
    throw new Error(`Import up to ${MAX_TRACKS} tracks at a time.`);
  // Each Spotify match has its own short server invocation. Large playlists do
  // not need one long-running function or background service.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, result.tracks.length) }, async () => {
      while (next < result.tracks.length) {
        const index = next++,
          item = result.tracks[index];
        if (typeof item.matchTicket !== "string") continue;
        try {
          const response = await sourceFetch(
            "/api/match",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ticket: item.matchTicket }),
              signal,
            },
            transport,
          );
          const matched = await response.json();
          result.tracks[index] = {
            ...item,
            ...(response.ok
              ? matched
              : { error: matched.detail || "No audio match found." }),
          };
        } catch (error) {
          if (signal.aborted) throw error;
          result.tracks[index] = {
            ...item,
            error: "Matching is temporarily unavailable. Re-import this track.",
          };
        }
      }
    }),
  );
  const tracks: Track[] = result.tracks.map((item: Record<string, unknown>) => {
    if (
      typeof item.title !== "string" ||
      (typeof item.mediaUrl !== "string" && typeof item.error !== "string")
    )
      throw new Error("The source returned an invalid track.");
    if (
      item.mediaUrl &&
      (typeof item.mediaUrl !== "string" ||
        !item.mediaUrl.startsWith("/api/audio?ticket="))
    )
      throw new Error("The source returned an invalid download link.");
    return {
      id: crypto.randomUUID(),
      title: item.title.slice(0, 300),
      artist: typeof item.artist === "string" ? item.artist.slice(0, 200) : "",
      duration: typeof item.duration === "number" ? item.duration : undefined,
      provider,
      transport,
      mediaUrl: typeof item.mediaUrl === "string" ? item.mediaUrl : undefined,
      extension:
        typeof item.extension === "string" &&
        /^[a-z0-9]{1,5}$/.test(item.extension)
          ? item.extension
          : "m4a",
      sourceUrl:
        typeof item.sourceUrl === "string" &&
        ["YouTube", "SoundCloud", "Bandcamp"].includes(
          providerFor(parseUrl(item.sourceUrl)),
        )
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
export interface AudioInput {
  blob: Blob;
  extension: string;
  remuxTo?: string;
}
export async function fetchAudio(
  track: Track,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<AudioInput> {
  if (
    helperConnection() &&
    track.transport !== "helper" &&
    track.sourceUrl &&
    track.mediaUrl?.startsWith("/api/audio?ticket=")
  ) {
    const response = await sourceFetch(
      "/api/resolve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: track.sourceUrl }),
        signal,
      },
      "helper",
    );
    const result = await response.json();
    const resolved = result.tracks?.[0];
    if (!response.ok || !resolved?.mediaUrl?.startsWith("/api/audio?ticket="))
      throw new Error(
        result.detail ||
          resolved?.error ||
          "Re-import this track with the helper connected.",
      );
    return fetchAudio(
      { ...track, mediaUrl: resolved.mediaUrl, transport: "helper" },
      signal,
      onProgress,
    );
  }
  if (!track.mediaUrl?.startsWith("/api/audio?ticket="))
    return fetchDirectAudio(track, signal, onProgress);
  const response = await sourceFetch(
    track.mediaUrl,
    { signal },
    track.transport,
  );
  const manifest = await response.json().catch(() => null);
  if (
    !response.ok &&
    !track.transport &&
    /web server|from this server|blocking requests|download engine/i.test(
      manifest?.detail || "",
    )
  )
    throw new HelperRequiredError(
      "Connect the desktop helper to download from your computer.",
    );
  if (!response.ok)
    throw new Error(
      manifest?.detail || "This audio is unavailable. Re-import the source.",
    );
  if (
    !manifest ||
    !Array.isArray(manifest.parts) ||
    !manifest.parts.length ||
    manifest.parts.length > 3000 ||
    !/^[a-z0-9]{1,5}$/.test(manifest.extension)
  )
    throw new Error("This source returned an invalid audio stream.");
  if (track.transport === "helper" && typeof manifest.browserUrl === "string") {
    const remote = parseUrl(manifest.browserUrl);
    if (
      remote.protocol === "https:" &&
      [
        "googlevideo.com",
        "sndcdn.com",
        "bcbits.com",
        "bandcamp.com",
        "youtube.com",
        "soundcloud.com",
      ].some(
        (host) =>
          remote.hostname === host || remote.hostname.endsWith(`.${host}`),
      )
    ) {
      try {
        const direct = await fetchDirectAudio(
          { ...track, mediaUrl: remote.href, extension: manifest.extension },
          signal,
          onProgress,
        );
        return { ...direct, remuxTo: manifest.remuxTo };
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
  }
  const controller = new AbortController(),
    combined = AbortSignal.any([signal, controller.signal]);
  const chunkSize = 2 * 1024 * 1024;
  const pieces: Uint8Array<ArrayBuffer>[][] = new Array(manifest.parts.length);
  let next = 0,
    received = 0,
    complete = 0;
  async function readRange(part: string, offset: number) {
    const response = await sourceFetch(
      part,
      {
        signal: combined,
        headers: { Range: `bytes=${offset}-${offset + chunkSize - 1}` },
      },
      track.transport,
    );
    if (response.status === 416 && offset > 0)
      return {
        bytes: [] as Uint8Array<ArrayBuffer>[],
        count: 0,
        total: offset,
        more: false,
      };
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(
        error?.detail || "This audio source expired. Import it again.",
      );
    }
    const range = response.headers
      .get("content-range")
      ?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
    if (
      response.status !== 206 ||
      !range ||
      Number(range[1]) !== offset ||
      !response.body
    )
      throw new Error("The source returned an invalid audio range.");
    const total = range[3] === "*" ? 0 : Number(range[3]);
    if (total > MAX_FILE_BYTES)
      throw new Error("This track exceeds the browser download limit.");
    const reader = response.body.getReader(),
      bytes: Uint8Array<ArrayBuffer>[] = [];
    let count = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        count += value.length;
        received += value.length;
        if (count > chunkSize || received > MAX_FILE_BYTES)
          throw new Error("This track exceeds the browser download limit.");
        bytes.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    if (!count || count !== Number(range[2]) - offset + 1)
      throw new Error("The audio transfer was interrupted. Try again.");
    onProgress(
      manifest.parts.length === 1 && total
        ? received / total
        : complete / manifest.parts.length,
    );
    return {
      bytes,
      count,
      total,
      more: response.headers.get("X-Audio-More") === "1",
    };
  }
  try {
    await Promise.all(
      Array.from({ length: Math.min(3, manifest.parts.length) }, async () => {
        while (next < manifest.parts.length) {
          const index = next++,
            part = manifest.parts[index];
          if (
            typeof part !== "string" ||
            !part.startsWith("/api/media?ticket=")
          )
            throw new Error("Invalid audio segment.");
          const first = await readRange(part, 0);
          const chunks: Uint8Array<ArrayBuffer>[][] = [first.bytes];
          if (first.more && first.total) {
            const starts = Array.from(
              { length: Math.ceil((first.total - first.count) / chunkSize) },
              (_, i) => first.count + i * chunkSize,
            );
            let cursor = 0;
            await Promise.all(
              Array.from({ length: Math.min(3, starts.length) }, async () => {
                while (cursor < starts.length) {
                  const index = cursor++;
                  const result = await readRange(part, starts[index]);
                  if (
                    result.total !== first.total ||
                    result.count !==
                      Math.min(chunkSize, first.total - starts[index])
                  )
                    throw new Error(
                      "The audio transfer was interrupted. Try again.",
                    );
                  chunks[index + 1] = result.bytes;
                }
              }),
            );
          } else if (first.more) {
            let offset = first.count;
            while (true) {
              const result = await readRange(part, offset);
              chunks.push(result.bytes);
              offset += result.count;
              if (!result.more) break;
            }
          }
          pieces[index] = chunks.flat();
          complete++;
          onProgress(complete / manifest.parts.length);
        }
      }),
    );
  } catch (error) {
    controller.abort();
    throw error;
  }
  if (!received) throw new Error("The source returned an empty file.");
  return {
    blob: new Blob(pieces.flat()),
    extension: manifest.extension,
    remuxTo: ["m4a", "mp3", "opus", "ogg"].includes(manifest.remuxTo)
      ? manifest.remuxTo
      : undefined,
  };
}
async function fetchDirectAudio(
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
