import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TRACKS } from "@/lib/model";
import { HttpError } from "./security";
import { extractionFailure, ExtractionError } from "./extraction-error";
export interface Extracted {
  id?: string;
  title?: string;
  track?: string;
  artist?: string;
  uploader?: string;
  uploader_id?: string;
  channel?: string;
  duration?: number;
  url?: string;
  webpage_url?: string;
  ext?: string;
  protocol?: string;
  acodec?: string;
  is_live?: boolean;
  vcodec?: string;
  fragments?: { url?: string; path?: string; range?: string }[];
  fragment_base_url?: string;
  http_headers?: Record<string, string>;
  thumbnail?: string;
  thumbnails?: { url?: string; width?: number; height?: number }[];
  entries?: Extracted[];
  formats?: unknown[];
  filesize?: number;
  filesize_approx?: number;
}
async function extractUncached(
  url: string,
  flat = false,
  signal?: AbortSignal,
  profile?: "web_embedded" | "web_safari",
): Promise<Extracted> {
  const youtube =
    /^https:\/\/(?:www\.|music\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(url);
  const binary = join(
    process.cwd(),
    ".server",
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
  );
  const args = [
    "--ignore-config",
    // Reuse SoundCloud client IDs and YouTube player data across runs.
    "--cache-dir",
    join(tmpdir(), "musicdownloader-yt-dlp"),
    "--no-warnings",
    "--no-progress",
    "--socket-timeout",
    "10",
    "--retries",
    "1",
    "--extractor-retries",
    "1",
    "--use-extractors",
    "youtube.*,soundcloud.*,bandcamp.*",
    "--no-js-runtimes",
    "--js-runtimes",
    `node:${process.execPath}`,
    "--dump-single-json",
    "--skip-download",
  ];
  args.push(
    "-f",
    "bestaudio[protocol=https]/bestaudio[protocol=http]/bestaudio/best",
  );
  if (flat)
    args.push(
      "--flat-playlist",
      "--playlist-end",
      String(MAX_TRACKS + 1),
      "--ignore-no-formats-error",
    );
  else args.push("--no-playlist");
  if (profile)
    args.push("--extractor-args", `youtube:player_client=${profile}`);
  args.push("--", url);
  return new Promise((resolve, reject) => {
    const process = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    process.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString("utf8")).slice(-32768);
    });
    let bytes = 0,
      settled = false;
    const finish = (error?: Error, data?: Extracted) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(data!);
    };
    const abort = () => {
      process.kill("SIGKILL");
      finish(new HttpError(499, "Import cancelled."));
    };
    const timeout = setTimeout(
      () => {
        process.kill("SIGKILL");
        finish(
          new ExtractionError(
            "SOURCE_TIMEOUT",
            "This source took too long. Please try again.",
            true,
            504,
          ),
        );
      },
      youtube ? 18000 : 45000,
    );
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    process.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        process.kill("SIGKILL");
        finish(new HttpError(422, "This playlist is too large."));
      } else chunks.push(chunk);
    });
    process.on("error", () =>
      finish(
        new ExtractionError(
          "EXTRACTOR_RUNTIME",
          "The download engine could not start on the web server.",
          false,
          503,
        ),
      ),
    );
    process.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const failure = extractionFailure(stderr, youtube);
        // Keep logs useful without printing source links, headers, or signed URLs.
        console.warn(
          `[media-extractor] ${failure.category}; profile=${profile || "default"}; exit=${code}`,
        );
        finish(failure);
        return;
      }
      try {
        finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(
          new HttpError(502, "The source returned an invalid track list."),
        );
      }
    });
  });
}

// Retry public playback clients for the same recording. Racing alternatives
// keeps the complete operation below the serverless request budget.
async function extractWithFallbacks(
  url: string,
  flat: boolean,
  signal?: AbortSignal,
): Promise<Extracted> {
  try {
    return await extractUncached(url, flat, signal);
  } catch (error) {
    if (
      signal?.aborted ||
      !(error instanceof ExtractionError) ||
      !error.retryable
    )
      throw error;
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw error;
    }
    const video =
      target.hostname === "youtu.be" ||
      ([
        "youtube.com",
        "www.youtube.com",
        "music.youtube.com",
        "m.youtube.com",
      ].includes(target.hostname) &&
        (target.pathname === "/watch" ||
          /^\/(?:shorts|embed|live)\//.test(target.pathname)));
    if (!video) throw error;
    const stop = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, stop.signal])
      : stop.signal;
    try {
      return await Promise.any([
        extractUncached(url, flat, combined, "web_embedded"),
        extractUncached(url, flat, combined, "web_safari"),
      ]);
    } catch {
      if (signal?.aborted) throw new HttpError(499, "Import cancelled.");
      throw error;
    } finally {
      stop.abort();
    }
  }
}

// Warm invocations reuse recent lookups and share concurrent requests. Nothing
// is persisted, and short expiry avoids retaining stale signed CDN links.
const cache = new Map<string, { value: Extracted; expires: number }>();
const pending = new Map<string, Promise<Extracted>>();
export async function extract(
  url: string,
  flat = false,
  signal?: AbortSignal,
): Promise<Extracted> {
  const key = `${flat}:${url}`,
    saved = cache.get(key);
  if (saved && saved.expires > Date.now()) return saved.value;
  if (pending.has(key)) return pending.get(key)!;
  const request = extractWithFallbacks(url, flat, signal)
    .then((value) => {
      cache.set(key, { value, expires: Date.now() + 180000 });
      if (flat && !value.entries && value.url)
        cache.set(`false:${url}`, { value, expires: Date.now() + 180000 });
      while (cache.size > 32) cache.delete(cache.keys().next().value!);
      return value;
    })
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

export function extractUsingClient(
  url: string,
  client: "web_embedded" | "web_safari",
  signal?: AbortSignal,
) {
  return extractUncached(url, false, signal, client);
}
export function invalidateExtraction(url: string) {
  cache.delete(`true:${url}`);
  cache.delete(`false:${url}`);
}

export function rememberExtraction(url: string, value: Extracted) {
  cache.set(`false:${url}`, { value, expires: Date.now() + 180000 });
  while (cache.size > 32) cache.delete(cache.keys().next().value!);
}
