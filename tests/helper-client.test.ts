import { afterEach, describe, expect, it, vi } from "vitest";
import { helperFetch } from "../src/lib/helper";
import { resolveLink, fetchAudio } from "../src/lib/sources";
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
  // Most CDNs refuse cross-origin reads, and each refusal left a CORS error
  // in the console, so audio always comes through the helper.
  it("fetches audio through the helper, not straight from the CDN", async () => {
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
    // An older helper may still offer a CDN link; it is not used.
    expect(request.mock.calls.map(([url]) => url)).not.toContain(
      "https://audio.bcbits.com/song.mp3",
    );
    expect(request.mock.calls[1][0]).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/api\/media/,
    );
  });
  it("does not allow the helper transport to address arbitrary local paths", async () => {
    connect();
    await expect(helperFetch("/private-file")).rejects.toThrow(
      "Invalid helper request",
    );
  });
});
