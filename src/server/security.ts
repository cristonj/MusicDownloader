import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isMediaHost, providerFor } from "@/lib/model";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type SourceTicket = { kind: "source"; url: string };
export type MediaTicket = {
  kind: "media";
  url: string;
  headers: Record<string, string>;
  range?: [number, number];
};
type MatchTicket = {
  kind: "match";
  title: string;
  artist: string;
  duration?: number;
};
type LookupTicket = { kind: "lookup"; url: string };
type Ticket = SourceTicket | MediaTicket | MatchTicket | LookupTicket;
let signingKey: string | undefined;
const key = () =>
  (signingKey ??= readFileSync(join(process.cwd(), ".server/key"), "utf8"));
export function signTicket(value: Ticket): string {
  const body = Buffer.from(
    JSON.stringify({ ...value, exp: Date.now() + 60 * 60 * 1000 }),
  ).toString("base64url");
  return `${body}.${createHmac("sha256", key()).update(body).digest("base64url")}`;
}
export function readTicket<T extends Ticket["kind"]>(
  token: string,
  kind: T,
): Extract<Ticket, { kind: T }> {
  try {
    if (!token || token.length > 16000) throw new Error();
    const [body, signature, extra] = token.split(".");
    const expected = createHmac("sha256", key()).update(body).digest();
    const received = Buffer.from(signature || "", "base64url");
    if (
      extra ||
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    )
      throw new Error();
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (value.kind !== kind || typeof value.exp !== "number") throw new Error();
    if (value.exp < Date.now())
      throw new HttpError(410, "This link expired. Import it again.");
    if (kind === "source" || kind === "lookup") allowedSource(value.url);
    else if (kind === "media") allowedMedia(value.url);
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(403, "Invalid download link.");
  }
}
export function allowedSource(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "Paste a complete music link.");
  }
  const provider = providerFor(url);
  const validHosts =
    provider === "YouTube" ||
    (provider === "Spotify" &&
      ["open.spotify.com", "spotify.link"].includes(url.hostname)) ||
    (provider === "Bandcamp" &&
      /^(?:[a-z0-9-]+\.)?bandcamp\.com$/.test(url.hostname)) ||
    (provider === "SoundCloud" &&
      (/^(?:www\.|m\.|on\.)?soundcloud\.com$/.test(url.hostname) ||
        // Large SoundCloud sets only list IDs after the first few tracks.
        (/^api(?:-v2)?\.soundcloud\.com$/.test(url.hostname) &&
          /^\/tracks\/\d+\/?$/.test(url.pathname))));
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !validHosts
  )
    throw new HttpError(
      400,
      "Use a YouTube, Spotify, SoundCloud, or Bandcamp link.",
    );
  // Music share links identify the same recordings as regular YouTube.
  // Use one extraction/cache path without the share-specific tracking token.
  if (provider === "YouTube") {
    if (url.hostname === "music.youtube.com") url.hostname = "www.youtube.com";
    url.searchParams.delete("si");
  }
  return url;
}
export function allowedMedia(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !isMediaHost(url.hostname)
  )
    throw new HttpError(422, "This source returned an unsupported audio host.");
  return url;
}
const buckets = new Map<string, { time: number; count: number }>();
export function guardRequest(request: Request, limit = 600) {
  const origin = request.headers.get("origin");
  // A self-hosted server sees its bind address (0.0.0.0) in request.url, so
  // also accept the Host the browser actually addressed.
  const hosts = [new URL(request.url).host, request.headers.get("host")];
  let originHost: string | undefined;
  try {
    originHost = origin ? new URL(origin).host : undefined;
  } catch {}
  if (origin && (!originHost || !hosts.includes(originHost)))
    throw new HttpError(403, "Cross-origin requests are not allowed.");
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new HttpError(403, "Cross-site requests are not allowed.");
  if (buckets.size > 2048) buckets.clear();
  const ip =
    request.headers.get("x-nf-client-connection-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0] ||
    "local";
  const bucketKey = `${ip}:${new URL(request.url).pathname}`;
  const now = Date.now(),
    previous = buckets.get(bucketKey);
  const bucket =
    previous && previous.time > now - 60000
      ? previous
      : { time: now, count: 0 };
  if (++bucket.count > limit)
    throw new HttpError(429, "Please wait a moment and try again.");
  buckets.set(bucketKey, bucket);
}
export const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
export function errorResponse(error: unknown): Response {
  return Response.json(
    {
      detail:
        error instanceof HttpError
          ? error.message
          : "This source could not be opened. Try another link or import your audio file.",
    },
    {
      status: error instanceof HttpError ? error.status : 502,
      headers: privateHeaders,
    },
  );
}
export async function readBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "A music link is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) {
        await reader.cancel();
        throw new HttpError(413, "Request too large.");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Use a valid music link.");
  }
}
