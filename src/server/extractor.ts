import { spawn } from "node:child_process";
import { join } from "node:path";
import { HttpError } from "./security";
export interface Extracted {
  id?: string;
  title?: string;
  track?: string;
  artist?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  url?: string;
  webpage_url?: string;
  ext?: string;
  protocol?: string;
  acodec?: string;
  is_live?: boolean;
  http_headers?: Record<string, string>;
  entries?: Extracted[];
  filesize?: number;
  filesize_approx?: number;
}
async function extractUncached(
  url: string,
  flat = false,
  signal?: AbortSignal,
): Promise<Extracted> {
  const binary = join(
    process.cwd(),
    ".server",
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
  );
  const args = [
    "--ignore-config",
    "--no-cache-dir",
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
    "--js-runtimes",
    `node:${process.execPath}`,
    "--dump-single-json",
    "--skip-download",
  ];
  args.push(
    "-f",
    "bestaudio[protocol=https]/bestaudio[protocol=http]/bestaudio/best",
  );
  if (flat) args.push("--flat-playlist", "--playlist-end", "101");
  else args.push("--no-playlist");
  args.push("--", url);
  return new Promise((resolve, reject) => {
    const process = spawn(binary, args, {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
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
    const timeout = setTimeout(() => {
      process.kill("SIGKILL");
      finish(
        new HttpError(
          504,
          "This source took too long. Try a smaller playlist or another link.",
        ),
      );
    }, 45000);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    process.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) {
        process.kill("SIGKILL");
        finish(new HttpError(422, "This playlist is too large."));
      } else chunks.push(chunk);
    });
    process.on("error", () =>
      finish(
        new HttpError(
          503,
          "The music service is temporarily unavailable. Please try again.",
        ),
      ),
    );
    process.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(
          new HttpError(
            422,
            "This track is unavailable, private, or temporarily blocked by the source.",
          ),
        );
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
  const request = extractUncached(url, flat, signal)
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
