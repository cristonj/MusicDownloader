import {
  helperConnection,
  HelperRequiredError,
  sourceFetch as directFetch,
} from "./helper";
import {
  extensionFor,
  isArtworkUrl,
  isMatchProvider,
  MAX_TRACKS,
  parseUrl,
  providerFor,
  type Provider,
  type Track,
} from "./model";

const wait = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
// Large batches can briefly exceed the server's request budget or meet a busy
// source. Back off and retry instead of failing the track.
async function sourceFetch(
  ...args: Parameters<typeof directFetch>
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await directFetch(...args);
    if (![429, 502, 503, 504].includes(response.status) || attempt >= 5)
      return response;
    await response.body?.cancel().catch(() => {});
    const after = Number(response.headers.get("retry-after")) * 1000;
    await wait(
      after || Math.min(15000, 1000 * 2 ** attempt + Math.random() * 1000),
      args[1]?.signal,
    );
  }
}
export function localTrack(file: File): Track {
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
// A resolved track and a feed row become a library track the same way, so a
// track added from the feed carries the same tickets, labels, and review
// state as one imported from a link.
export function trackFromItem(
  item: Record<string, unknown>,
  provider: Provider,
  transport?: "helper",
): Track {
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
    artwork:
      typeof item.artwork === "string" && isArtworkUrl(item.artwork)
        ? item.artwork
        : undefined,
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
    matchedChannel:
      typeof item.matchedChannel === "string"
        ? item.matchedChannel.slice(0, 200)
        : undefined,
    matchReason:
      typeof item.matchReason === "string"
        ? item.matchReason.slice(0, 300)
        : undefined,
    // Matched tracks can search again for another upload if theirs fails.
    fallbackTicket:
      typeof item.fallbackTicket === "string"
        ? item.fallbackTicket
        : typeof item.matchTicket === "string"
          ? item.matchTicket
          : undefined,
    // Every match starts selected; the uncertain ones are flagged in the
    // list rather than left for the listener to tick one by one.
    selected: !item.error,
    status: item.error ? "error" : "ready",
    error: typeof item.error === "string" ? item.error : undefined,
    progress: 0,
  };
}
export async function resolveLink(
  input: string,
  signal: AbortSignal,
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<{ title: string; tracks: Track[]; notice?: string }> {
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
  // Each lookup or Spotify match is its own short server invocation, so long
  // playlists need no long-running function and can report progress.
  const jobs = result.tracks.flatMap(
    (item: Record<string, unknown>, index: number) =>
      typeof item.lookupTicket === "string"
        ? [{ index, path: "/api/lookup", ticket: item.lookupTicket }]
        : typeof item.matchTicket === "string"
          ? [{ index, path: "/api/match", ticket: item.matchTicket }]
          : [],
  );
  const label =
    isMatchProvider(provider) ||
    jobs.every((job: { path: string }) => job.path === "/api/match")
      ? "Matching tracks on YouTube"
      : "Loading track details";
  let next = 0,
    done = 0;
  if (jobs.length) onProgress?.(0, jobs.length, label);
  await Promise.all(
    Array.from({ length: Math.min(8, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++],
          item = result.tracks[job.index];
        try {
          const response = await sourceFetch(
            job.path,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ticket: job.ticket }),
              signal,
            },
            transport,
          );
          const found = await response.json();
          // A DRM-locked track keeps its reason if no other upload is found.
          if (response.ok)
            result.tracks[job.index] = {
              ...item,
              ...found,
              error:
                found.error && item.error
                  ? `${item.error} ${found.error}`
                  : found.error,
            };
          // A failed lookup keeps its playable link; a failed match has none.
          else if (job.path === "/api/match")
            result.tracks[job.index] = {
              ...item,
              error: [item.error, found.detail || "No audio match found."]
                .filter(Boolean)
                .join(" "),
            };
        } catch (error) {
          if (signal.aborted) throw error;
          if (job.path === "/api/match")
            result.tracks[job.index] = {
              ...item,
              error:
                "Matching is temporarily unavailable. Re-import this track.",
            };
        }
        onProgress?.(++done, jobs.length, label);
      }
    }),
  );
  const tracks: Track[] = result.tracks.map((item: Record<string, unknown>) =>
    trackFromItem(item, provider, transport),
  );
  return {
    title:
      typeof result.title === "string" ? result.title.slice(0, 300) : provider,
    tracks,
    notice:
      typeof result.notice === "string"
        ? result.notice.slice(0, 300)
        : undefined,
  };
}
export interface AudioInput {
  blob: Blob;
  extension: string;
  remuxTo?: string;
}
// A source can refuse audio only once the stream is opened (DRM, removal,
// region or bot blocks, dead CDN links). Retry the source with a fresh
// extraction, then download the next-best uploads of the same recording.
export async function fetchAudio(
  track: Track,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<AudioInput> {
  const message = (error: unknown) =>
    error instanceof Error ? error.message : "";
  const attempt = async (candidate: Track) => {
    try {
      return await fetchSourceAudio(candidate, signal, onProgress);
    } catch (error) {
      if (
        signal.aborted ||
        !candidate.mediaUrl?.startsWith("/api/audio?ticket=") ||
        !/expired|interrupted|try again|unavailable|could not/i.test(
          message(error),
        )
      )
        throw error;
      await wait(1500, signal);
      // Skip the server's cached extraction, whose links may be dead.
      // Report the original failure; the retry's own error says less.
      return fetchSourceAudio(
        { ...candidate, mediaUrl: `${candidate.mediaUrl}&fresh=1` },
        signal,
        onProgress,
      ).catch((retry) => {
        throw signal.aborted ? retry : error;
      });
    }
  };
  let failure: unknown;
  try {
    return await attempt(track);
  } catch (error) {
    failure = error;
  }
  const tried = track.sourceUrl ? [track.sourceUrl] : [];
  for (let round = 0; round < 3; round++) {
    if (
      signal.aborted ||
      !track.fallbackTicket ||
      /memory|limit|exceeds/i.test(message(failure))
    )
      throw failure;
    const response = await sourceFetch(
      "/api/match",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: track.fallbackTicket, exclude: tried }),
        signal,
      },
      track.transport,
    );
    const found = await response.json().catch(() => null);
    if (
      !response.ok ||
      typeof found?.mediaUrl !== "string" ||
      !found.mediaUrl.startsWith("/api/audio?ticket=") ||
      typeof found.sourceUrl !== "string" ||
      tried.includes(found.sourceUrl)
    )
      throw new Error(
        `${message(failure)} ${found?.error || found?.detail || "No other upload of this track was found."}`,
      );
    tried.push(found.sourceUrl);
    try {
      return await attempt({
        ...track,
        mediaUrl: found.mediaUrl,
        sourceUrl: found.sourceUrl,
        extension: "m4a",
      });
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
async function fetchSourceAudio(
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
  const controller = new AbortController(),
    combined = AbortSignal.any([signal, controller.signal]);
  const chunkSize = 2 * 1024 * 1024;
  const pieces: Blob[][] = new Array(manifest.parts.length);
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
        blob: new Blob(),
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
    const reader = response.body.getReader(),
      bytes: Uint8Array<ArrayBuffer>[] = [];
    let count = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        count += value.length;
        received += value.length;
        if (count > chunkSize)
          throw new Error("The source returned an oversized audio chunk.");
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
      blob: new Blob(bytes),
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
          const chunks: Blob[] = [first.blob];
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
                  chunks[index + 1] = result.blob;
                }
              }),
            );
          } else if (first.more) {
            let offset = first.count;
            while (true) {
              const result = await readRange(part, offset);
              chunks.push(result.blob);
              offset += result.count;
              if (!result.more) break;
            }
          }
          pieces[index] = chunks;
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
  if (!response.body) throw new Error("This source did not return audio.");
  const reader = response.body.getReader();
  const chunks: Blob[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      chunks.push(new Blob([value]));
      onProgress(total ? received / total : 0);
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
