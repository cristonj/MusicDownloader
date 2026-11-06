import { afterEach, describe, expect, it, vi } from "vitest";
import { helperFetch } from "../src/lib/helper";
import { resolveLink, fetchAudio } from "../src/lib/sources";
import { loadFeed } from "../src/lib/feed";
const token = "a".repeat(43);
afterEach(() => vi.unstubAllGlobals());
function connect() {
  vi.stubGlobal("localStorage", {
    getItem: () => JSON.stringify({ token, port: 45821 }),
  });
}
describe("browser/helper transport", () => {
  it.each([
    "https://music.youtube.com/watch?v=xKJtIjB3pAI",
    "https://soundcloud.com/artist/song",
    "https://artist.bandcamp.com/track/song",
    "https://open.spotify.com/track/1234567890123456789012",
  ])("keeps %s resolution on the user’s machine", async (url) => {
    connect();
    const request = vi.fn(async (_url: string, _options?: RequestInit) =>
      Response.json({
        title: "Song",
        tracks: [
          {
            title: "Song",
            mediaUrl: "/api/audio?ticket=local",
            extension: "m4a",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", request);
    const result = await resolveLink(url, new AbortController().signal);
    expect(result.tracks[0].transport).toBe("helper");
    expect(request.mock.calls[0][0]).toBe("http://127.0.0.1:45821/api/resolve");
    expect(
      new Headers(request.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe(`Bearer ${token}`);
  });
  it("searches with the helper's own ticket when a web-imported upload is DRM-only", async () => {
    connect();
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        if (url.endsWith("/api/resolve"))
          return Response.json({
            tracks: [
              {
                title: "Locked",
                error: "SoundCloud doesn’t allow this track (DRM).",
                matchTicket: "helper-signed",
              },
            ],
          });
        if (url.endsWith("/api/match")) {
          bodies.push(JSON.parse(String(options?.body)));
          return Response.json({
            mediaUrl: "/api/audio?ticket=other",
            sourceUrl: "https://www.youtube.com/watch?v=officialaud",
            matchedTitle: "Locked",
          });
        }
        if (url.includes("/api/audio"))
          return Response.json({
            extension: "webm",
            parts: ["/api/media?ticket=part"],
          });
        return new Response("audio", {
          status: 206,
          headers: { "content-range": "bytes 0-4/5" },
        });
      }),
    );
    const result = await fetchAudio(
      {
        id: "1",
        title: "Locked",
        artist: "",
        provider: "SoundCloud",
        mediaUrl: "/api/audio?ticket=web",
        sourceUrl: "https://soundcloud.com/label/locked",
        fallbackTicket: "web-signed",
        extension: "m4a",
        selected: true,
        status: "ready",
        progress: 0,
      },
      new AbortController().signal,
      () => {},
    );
    expect(bodies[0].ticket).toBe("helper-signed");
    expect(result.replacement?.sourceUrl).toBe(
      "https://www.youtube.com/watch?v=officialaud",
    );
  });
  it("proxies helper audio without attempting CORS-blocked CDN requests", async () => {
    connect();
    const request = vi.fn(async (url: string) =>
      url.includes("/api/audio")
        ? Response.json({
            extension: "mp3",
            parts: ["/api/media?ticket=local"],
            browserUrl: "https://audio.bcbits.com/song.mp3",
          })
        : new Response(new Uint8Array([1, 2, 3]), {
            status: 206,
            headers: {
              "Content-Type": "audio/mpeg",
              "Content-Range": "bytes 0-2/3",
              "X-Audio-More": "0",
            },
          }),
    );
    vi.stubGlobal("fetch", request);
    const result = await fetchAudio(
      {
        id: "1",
        title: "Song",
        artist: "",
        provider: "Bandcamp",
        mediaUrl: "/api/audio?ticket=local",
        transport: "helper",
        extension: "mp3",
        selected: true,
        status: "ready",
        progress: 0,
      },
      new AbortController().signal,
      () => {},
    );
    expect(result.blob.size).toBe(3);
    expect(request.mock.calls[1][0]).toBe(
      "http://127.0.0.1:45821/api/media?ticket=local",
    );
    expect(
      request.mock.calls.every(([url]) =>
        url.startsWith("http://127.0.0.1:45821/"),
      ),
    ).toBe(true);
  });
  it("loads discovery through the connected helper and binds its tickets to that transport", async () => {
    connect();
    const request = vi.fn(async () =>
      Response.json({
        title: "Search",
        tracks: [{ title: "Song", matchTicket: "local-ticket" }],
      }),
    );
    vi.stubGlobal("fetch", request);
    const column = await loadFeed(
      "Apple Music",
      "Song",
      25,
      new AbortController().signal,
    );
    expect(request).toHaveBeenCalledWith(
      "http://127.0.0.1:45821/api/feed",
      expect.anything(),
    );
    expect(column.rows[0].transport).toBe("helper");
  });
  it("does not allow the helper transport to address arbitrary local paths", async () => {
    connect();
    await expect(helperFetch("/private-file")).rejects.toThrow(
      "Invalid helper request",
    );
  });
});
