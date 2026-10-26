import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowedMedia,
  allowedSource,
  guardRequest,
  HttpError,
  readTicket,
  signTicket,
} from "../src/server/security";
import { matchScore } from "../src/server/catalog";
import { CHUNK_BYTES, hlsManifest, mediaChunk } from "../src/server/media";
import { mediaFetch } from "../src/server/upstream";
import { extract } from "../src/server/extractor";
import { POST as resolve } from "../src/app/api/resolve/route";
import { GET as audio } from "../src/app/api/audio/route";
import { GET as media } from "../src/app/api/media/route";
vi.mock("../src/server/upstream", () => ({
  mediaFetch: vi.fn(),
  publicFetch: vi.fn(),
}));
vi.mock("../src/server/extractor", () => ({
  extract: vi.fn(),
  extractUsingClient: vi.fn(),
  invalidateExtraction: vi.fn(),
  rememberExtraction: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

describe("private server endpoints", () => {
  it("rejects lookalikes, credentials, ports, and arbitrary CDN proxy targets", () => {
    for (const url of [
      "http://youtube.com/watch?v=x",
      "https://youtube.com.attacker.test/x",
      "https://user:pass@youtube.com/x",
      "https://youtube.com:123/x",
    ])
      expect(() => allowedSource(url)).toThrow();
    expect(
      allowedSource("https://artist.bandcamp.com/album/test").hostname,
    ).toBe("artist.bandcamp.com");
    for (const url of [
      "https://localhost/file.mp3",
      "https://attacker.test/file.mp3",
      "https://googlevideo.com.attacker.test/file",
    ])
      expect(() => allowedMedia(url)).toThrow();
    expect(
      allowedMedia("https://r1.googlevideo.com/videoplayback").protocol,
    ).toBe("https:");
  });
  it("signs typed expiring tickets without a configured secret", () => {
    const token = signTicket({
      kind: "source",
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    });
    expect(readTicket(token, "source").url).toContain("youtube.com");
    expect(() => readTicket(token + "x", "source")).toThrow();
    expect(() => readTicket(token, "media")).toThrow();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 60 * 1000);
    expect(() => readTicket(token, "source")).toThrow("expired");
    vi.restoreAllMocks();
  });
  it("rejects cross-origin calls and oversized requests before extraction", async () => {
    const forbidden = await resolve(
      new Request("http://localhost/api/resolve", {
        method: "POST",
        headers: { Origin: "https://other.test" },
        body: "{}",
      }),
    );
    expect(forbidden.status).toBe(403);
    // Self-hosted servers see their bind address in request.url.
    const selfHosted = (origin: string) =>
      guardRequest(
        new Request("http://0.0.0.0:8080/api/resolve", {
          method: "POST",
          headers: { Origin: origin, Host: "localhost:8080" },
        }),
      );
    expect(() => selfHosted("http://localhost:8080")).not.toThrow();
    expect(() => selfHosted("https://other.test")).toThrow("Cross-origin");
    expect(() => selfHosted("null")).toThrow("Cross-origin");
    const tooLarge = await resolve(
      new Request("http://localhost/api/resolve", {
        method: "POST",
        body: "x".repeat(9000),
      }),
    );
    expect(tooLarge.status).toBe(413);
    expect(extract).not.toHaveBeenCalled();
  });
  it("resolves a public source through the same app with no resolver URL", async () => {
    vi.mocked(extract).mockResolvedValue({
      title: "A song",
      webpage_url: "https://www.youtube.com/watch?v=abcdefghijk",
      ext: "m4a",
    });
    const response = await resolve(
      new Request("http://localhost/api/resolve", {
        method: "POST",
        body: JSON.stringify({
          url: "https://www.youtube.com/watch?v=abcdefghijk",
        }),
      }),
    );
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.tracks[0].mediaUrl).toMatch(/^\/api\/audio\?ticket=/);
    expect(result.tracks[0].title).toBe("A song");
  });
  it("completes SoundCloud set entries that only list a track ID", async () => {
    vi.mocked(extract).mockImplementation(async (url) =>
      url.includes("/sets/")
        ? {
            title: "A set",
            entries: [
              {
                title: "First",
                url: "https://soundcloud.com/artist/first",
              },
              { id: "12", url: "https://api-v2.soundcloud.com/tracks/12" },
              { id: "13", url: "https://api-v2.soundcloud.com/tracks/13" },
              { id: "14", url: "https://api-v2.soundcloud.com/tracks/14" },
            ],
          }
        : url.endsWith("/12")
          ? {
              title: "Second",
              uploader: "Artist",
              webpage_url: "https://soundcloud.com/artist/second",
            }
          : url.endsWith("/14")
            ? { title: "Locked", formats: [] }
            : Promise.reject(new Error("unavailable")),
    );
    const response = await resolve(
      new Request("http://localhost/api/resolve", {
        method: "POST",
        body: JSON.stringify({ url: "https://soundcloud.com/artist/sets/a" }),
      }),
    );
    const { tracks } = await response.json();
    expect(tracks.map((x: { title: string }) => x.title)).toEqual([
      "First",
      "Second",
      "Untitled",
      "Locked",
    ]);
    expect(tracks[3].error).toMatch(/DRM/);
    expect(tracks[3].mediaUrl).toBeUndefined();
    expect(tracks[1]).toMatchObject({
      artist: "Artist",
      sourceUrl: "https://soundcloud.com/artist/second",
    });
    expect(tracks[2].sourceUrl).toBe("https://api-v2.soundcloud.com/tracks/13");
    expect(
      tracks.slice(0, 3).every((x: { mediaUrl?: string }) => x.mediaUrl),
    ).toBe(true);
    expect(() =>
      allowedSource("https://api-v2.soundcloud.com/me/likes"),
    ).toThrow();
  });
  it("opens YouTube Music share links through the regular YouTube audio path", async () => {
    const shared =
      "https://music.youtube.com/watch?v=xKJtIjB3pAI&si=3ZN4Gzsw8cDL-uIf";
    const canonical = "https://www.youtube.com/watch?v=xKJtIjB3pAI";
    vi.mocked(extract)
      .mockResolvedValueOnce({
        title: "Shared song",
        webpage_url: shared,
        ext: "m4a",
      })
      .mockResolvedValueOnce({
        url: "https://r1.googlevideo.com/audio",
        protocol: "https",
        ext: "m4a",
      });
    const response = await resolve(
      new Request("http://localhost/api/resolve", {
        method: "POST",
        body: JSON.stringify({ url: shared }),
      }),
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(extract).toHaveBeenNthCalledWith(
      1,
      canonical,
      true,
      expect.any(AbortSignal),
    );
    expect(result.tracks[0].sourceUrl).toBe(canonical);
    vi.mocked(mediaFetch).mockResolvedValue(
      new Response(new Uint8Array([1]), {
        headers: { "Content-Type": "audio/mp4" },
      }),
    );
    const download = await audio(
      new Request(`http://localhost${result.tracks[0].mediaUrl}`),
    );
    expect(download.status).toBe(200);
    expect(extract).toHaveBeenNthCalledWith(
      2,
      canonical,
      false,
      expect.any(AbortSignal),
    );
    expect((await download.json()).parts).toHaveLength(1);
    const playlist = allowedSource(shared + "&list=PLexample&index=3");
    expect(playlist.searchParams.get("list")).toBe("PLexample");
    expect(playlist.searchParams.get("index")).toBe("3");
  });
  it("opens a source only when its signed audio endpoint is requested", async () => {
    vi.mocked(extract).mockResolvedValue({
      url: "https://r1.googlevideo.com/audio",
      ext: "m4a",
      protocol: "https",
      http_headers: { "User-Agent": "test", Cookie: "never-forward" },
    });
    vi.mocked(mediaFetch).mockResolvedValue(
      new Response(new Uint8Array([1]), {
        headers: { "Content-Type": "audio/mp4" },
      }),
    );
    const token = signTicket({
      kind: "source",
      url: "https://youtube.com/watch?v=abcdefghijk",
    });
    const response = await audio(
      new Request(`http://localhost/api/audio?ticket=${token}`),
    );
    const result = await response.json();
    expect(result.extension).toBe("m4a");
    expect(result.parts).toHaveLength(1);
    const ticket = readTicket(
      new URL(result.parts[0], "http://localhost").searchParams.get("ticket")!,
      "media",
    );
    expect(ticket.headers).toEqual({ "User-Agent": "test" });
  });
  it("prefers matching recordings over covers and live versions", () => {
    expect(
      matchScore("My Song", "An Artist", 200, {
        title: "An Artist - My Song (Official Audio)",
        duration: 200,
      }),
    ).toBeGreaterThan(0.9);
    expect(
      matchScore("My Song", "An Artist", 200, {
        title: "Other Artist - My Song (Live Cover)",
        duration: 200,
      }),
    ).toBeLessThan(0.58);
  });
});

describe("bounded audio transport", () => {
  const ticket = {
    kind: "media" as const,
    url: "https://r1.googlevideo.com/audio",
    headers: {},
  };
  it("transfers a large file as exact bounded ranges", async () => {
    const source = new Uint8Array(CHUNK_BYTES + 19);
    source.fill(123);
    vi.mocked(mediaFetch).mockImplementation(async (_url, headers) => {
      const range = headers.Range.match(/bytes=(\d+)-(\d+)/)!;
      const start = Number(range[1]),
        end = Math.min(Number(range[2]), source.length - 1);
      return new Response(source.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Type": "audio/mp4",
          "Content-Range": `bytes ${start}-${end}/${source.length}`,
        },
      });
    });
    const first = await mediaChunk(ticket, `bytes=0-${CHUNK_BYTES * 10}`);
    const last = await mediaChunk(
      ticket,
      `bytes=${CHUNK_BYTES}-${CHUNK_BYTES * 2 - 1}`,
    );
    expect(first.body.length).toBe(CHUNK_BYTES);
    expect(first.more).toBe(true);
    expect(last.body.length).toBe(19);
    expect(last.more).toBe(false);
    expect(
      Buffer.concat([first.body, last.body]).equals(Buffer.from(source)),
    ).toBe(true);
  });
  it("does not trust upstream ranges or pages disguised as media", async () => {
    vi.mocked(mediaFetch).mockResolvedValueOnce(
      new Response("abc", {
        status: 206,
        headers: {
          "Content-Type": "audio/mp4",
          "Content-Range": "bytes 99-101/200",
        },
      }),
    );
    await expect(mediaChunk(ticket, "bytes=0-2")).rejects.toThrow(
      "invalid audio range",
    );
    vi.mocked(mediaFetch).mockResolvedValueOnce(
      new Response("<html/>", { headers: { "Content-Type": "text/html" } }),
    );
    await expect(mediaChunk(ticket, null)).rejects.toThrow(
      "page instead of audio",
    );
  });
  it("supports a range-ignoring upstream while bounding each response", async () => {
    const bytes = new Uint8Array(CHUNK_BYTES + 25);
    bytes.fill(4);
    vi.mocked(mediaFetch).mockImplementation(
      async () =>
        new Response(bytes, {
          headers: {
            "Content-Type": "audio/mpeg",
            "Content-Length": String(bytes.length),
          },
        }),
    );
    const response = await mediaChunk(
      ticket,
      `bytes=${CHUNK_BYTES}-${CHUNK_BYTES * 2 - 1}`,
    );
    expect(response.body.length).toBe(25);
    expect(response.more).toBe(false);
  });
  it("signs HLS segments in order including init and byte-range data", async () => {
    vi.mocked(mediaFetch).mockResolvedValue(
      new Response(
        '#EXTM3U\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="10@0"\n#EXT-X-BYTERANGE:20@10\naudio.mp4\n#EXT-X-ENDLIST',
      ),
    );
    const result = await hlsManifest(
      "https://cf-media.sndcdn.com/list.m3u8",
      {},
    );
    expect(result.remuxTo).toBe("m4a");
    expect(result.parts).toHaveLength(2);
    const second = readTicket(
      new URL(result.parts[1], "http://localhost").searchParams.get("ticket")!,
      "media",
    );
    expect(second.url).toBe("https://cf-media.sndcdn.com/audio.mp4");
    expect(second.range).toEqual([10, 29]);
    expect(result.extension).toBe("mp4");
  });
  it("accepts SoundCloud's current HLS host", async () => {
    vi.mocked(mediaFetch).mockResolvedValue(
      new Response(
        '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\ndata000.m4s\n#EXT-X-ENDLIST',
      ),
    );
    const result = await hlsManifest(
      "https://playback.media-streaming.soundcloud.cloud/a/aac_96k/b/playlist.m3u8",
      {},
    );
    expect(result).toMatchObject({ extension: "mp4", remuxTo: "m4a" });
    expect(() =>
      allowedMedia("https://soundcloud.cloud.attacker.test/a.m4s"),
    ).toThrow();
  });
  it("rejects encrypted/live HLS and malformed ticket requests", async () => {
    vi.mocked(mediaFetch).mockResolvedValueOnce(
      new Response(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\na.ts\n#EXT-X-ENDLIST',
      ),
    );
    await expect(
      hlsManifest("https://cf-media.sndcdn.com/list.m3u8", {}),
    ).rejects.toThrow("encrypted");
    vi.mocked(mediaFetch).mockResolvedValueOnce(new Response("#EXTM3U\na.ts"));
    await expect(
      hlsManifest("https://cf-media.sndcdn.com/list.m3u8", {}),
    ).rejects.toThrow("Live");
    expect(
      (await media(new Request("http://localhost/api/media?ticket=bad")))
        .status,
    ).toBe(403);
  });
});
describe("extraction failures", () => {
  it("explains DRM-protected tracks", async () => {
    const { extractionFailure } =
      await import("../src/server/extraction-error");
    expect(
      extractionFailure(
        "ERROR: [soundcloud] 1: This video is DRM protected",
        false,
      ).message,
    ).toMatch(/DRM-protected/);
  });
});
