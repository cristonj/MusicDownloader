import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowedMedia,
  allowedSource,
  guardRequest,
  HttpError,
  readTicket,
  signTicket,
} from "../src/server/security";
import { matchScore, matchTrack, songName } from "../src/server/catalog";
import { providerFor } from "../src/lib/model";
import { CHUNK_BYTES, hlsManifest, mediaChunk } from "../src/server/media";
import { mediaFetch, publicFetch } from "../src/server/upstream";
import { extract } from "../src/server/extractor";
import { POST as resolve } from "../src/app/api/resolve/route";
import { POST as lookup } from "../src/app/api/lookup/route";
import { POST as feed } from "../src/app/api/feed/route";
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
  it("lets the browser complete SoundCloud set entries by ID", async () => {
    vi.mocked(extract).mockImplementation(async (url) =>
      url.includes("/sets/")
        ? {
            title: "A set",
            entries: [
              { title: "First", url: "https://soundcloud.com/artist/first" },
              { id: "12", url: "https://api-v2.soundcloud.com/tracks/12" },
              { id: "14", url: "https://api-v2.soundcloud.com/tracks/14" },
            ],
          }
        : url.endsWith("/12")
          ? {
              title: "Second",
              uploader: "Artist",
              webpage_url: "https://soundcloud.com/artist/second",
            }
          : { title: "Locked", formats: [] },
    );
    const response = await resolve(
      new Request("http://localhost/api/resolve", {
        method: "POST",
        body: JSON.stringify({ url: "https://soundcloud.com/artist/sets/a" }),
      }),
    );
    const { tracks } = await response.json();
    expect(tracks[0].lookupTicket).toBeUndefined();
    // Stubs stay downloadable by their API link while they await a lookup.
    expect(tracks[1]).toMatchObject({
      sourceUrl: "https://api-v2.soundcloud.com/tracks/12",
      mediaUrl: expect.stringMatching(/^\/api\/audio\?ticket=/),
    });
    const look = async (ticket: string) =>
      (
        await lookup(
          new Request("http://localhost/api/lookup", {
            method: "POST",
            body: JSON.stringify({ ticket }),
          }),
        )
      ).json();
    expect(await look(tracks[1].lookupTicket)).toMatchObject({
      title: "Second",
      artist: "Artist",
      sourceUrl: "https://soundcloud.com/artist/second",
    });
    const locked = await look(tracks[2].lookupTicket);
    expect(locked.error).toMatch(/DRM/);
    expect(locked.mediaUrl).toBeUndefined();
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
  it("explains which upload a Spotify track matched and why", async () => {
    vi.mocked(extract).mockResolvedValue({
      entries: [
        {
          id: "lyricslyric",
          title: "Radiohead - Creep (Lyrics)",
          channel: "LyricsZone",
          duration: 241,
        },
        {
          id: "officialaud",
          title: "Creep",
          channel: "Radiohead - Topic",
          duration: 238,
        },
        {
          id: "liveversion",
          title: "Radiohead - Creep (Live)",
          channel: "Radiohead",
          duration: 265,
        },
      ],
    });
    const match = await matchTrack({
      title: "Creep",
      artist: "Radiohead",
      duration: 238.6,
    });
    expect(match.sourceUrl).toBe("https://www.youtube.com/watch?v=officialaud");
    expect(match.matchReason).toMatch(
      /official audio channel · same length \(3:58\)/,
    );
    expect(match.matchConfident).toBe(true);
    vi.mocked(extract).mockResolvedValue({
      entries: [
        {
          id: "radioedit00",
          title: "Radiohead - Creep",
          channel: "Radiohead",
          duration: 200,
        },
      ],
    });
    const edit = await matchTrack({
      title: "Creep",
      artist: "Radiohead",
      duration: 238.6,
    });
    expect(edit.matchConfident).not.toBe(true);
    vi.mocked(extract).mockResolvedValue({
      entries: [
        {
          id: "pitched4320",
          title: "Radiohead The Tourist 432hz",
          channel: "Hertz Patrol",
          duration: 327,
        },
        {
          id: "fanupload00",
          title: "Radiohead - The Tourist",
          channel: "Album Burial",
          duration: 325,
        },
      ],
    });
    const fan = await matchTrack({
      title: "The Tourist",
      artist: "Radiohead",
      duration: 325.6,
    });
    expect(fan.sourceUrl).toBe("https://www.youtube.com/watch?v=fanupload00");
    expect(fan.matchReason).toMatch(
      /^Fan upload by Album Burial; no official upload found/,
    );
    expect(fan.matchConfidence).toBeLessThanOrEqual(0.75);
    expect(fan.matchConfident).toBe(false);
    const next = await matchTrack(
      { title: "The Tourist", artist: "Radiohead", duration: 325.6 },
      undefined,
      "Spotify",
      ["https://www.youtube.com/watch?v=fanupload00"],
    );
    expect(next.sourceUrl).not.toBe(
      "https://www.youtube.com/watch?v=fanupload00",
    );
  });
  it("finds a YouTube upload when SoundCloud refuses a track for DRM", async () => {
    vi.mocked(extract).mockImplementation(async (url) =>
      url.startsWith("ytsearch10:")
        ? {
            entries: [
              {
                id: "officialaud",
                title: "Locked Song",
                channel: "Some Artist - Topic",
                duration: 200,
              },
            ],
          }
        : {
            title: "Some Artist - Locked Song",
            duration: 200,
            formats: [],
            webpage_url: "https://soundcloud.com/label/locked",
          },
    );
    const found = await (
      await lookup(
        new Request("http://localhost/api/lookup", {
          method: "POST",
          body: JSON.stringify({
            ticket: signTicket({
              kind: "lookup",
              url: "https://api-v2.soundcloud.com/tracks/14",
            }),
          }),
        }),
      )
    ).json();
    expect(found.error).toBeUndefined();
    expect(found.sourceUrl).toBe("https://www.youtube.com/watch?v=officialaud");
    expect(found.matchReason).toMatch(/official audio channel/);
  });
  it("finds another upload when a source refuses a track", async () => {
    vi.mocked(extract).mockImplementation(async (url) =>
      url.startsWith("ytsearch10:")
        ? { entries: [] }
        : url.startsWith("scsearch10:")
          ? {
              entries: [
                {
                  id: "1",
                  title: "Locked Song",
                  uploader: "Some Artist",
                  duration: 200,
                  formats: [],
                  url: "https://soundcloud.com/some-artist/drm",
                },
                {
                  id: "2",
                  title: "Locked Song",
                  uploader: "Some Artist",
                  duration: 200,
                  url: "https://soundcloud.com/some-artist/locked-song",
                },
              ],
            }
          : {
              title: "Some Artist - Locked Song",
              duration: 200,
              formats: [],
              webpage_url: "https://soundcloud.com/label/locked",
            },
    );
    const found = await (
      await lookup(
        new Request("http://localhost/api/lookup", {
          method: "POST",
          body: JSON.stringify({
            ticket: signTicket({
              kind: "lookup",
              url: "https://api-v2.soundcloud.com/tracks/14",
            }),
          }),
        }),
      )
    ).json();
    expect(found.error).toBeUndefined();
    expect(found.sourceUrl).toBe(
      "https://soundcloud.com/some-artist/locked-song",
    );
    expect(found.matchReason).toMatch(/^On SoundCloud/);
    expect(vi.mocked(extract).mock.calls[1][0]).toBe(
      "ytsearch10:Some Artist Locked Song official audio",
    );
  });
  it("credits Bandcamp album tracks to the album artist", async () => {
    vi.mocked(extract).mockResolvedValue({
      title: "Album",
      uploader: "Band",
      entries: [{ title: "Song", url: "https://band.bandcamp.com/track/song" }],
    });
    const { tracks } = await (
      await resolve(
        new Request("http://localhost/api/resolve", {
          method: "POST",
          body: JSON.stringify({
            url: "https://band.bandcamp.com/album/album",
          }),
        }),
      )
    ).json();
    expect(tracks[0]).toMatchObject({ title: "Song", artist: "Band" });
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

describe("metadata-only services", () => {
  const importLink = async (url: string) =>
    resolve(
      new Request("http://localhost/api/resolve", {
        method: "POST",
        body: JSON.stringify({ url }),
      }),
    );
  const json = (value: unknown) => new Response(JSON.stringify(value));
  it("accepts Apple Music and Amazon Music links by host, not by lookalike", () => {
    expect(
      allowedSource("https://music.apple.com/us/album/dreams/1440857781")
        .hostname,
    ).toBe("music.apple.com");
    expect(
      allowedSource("https://music.amazon.co.uk/albums/B0CH3YL376").hostname,
    ).toBe("music.amazon.co.uk");
    for (const url of [
      "https://music.apple.com.attacker.test/us/album/x/1",
      "https://apple.com/us/album/x/1",
      "https://music.amazon.attacker.test/albums/B0CH3YL376",
      "http://music.apple.com/us/album/x/1",
    ])
      expect(() => allowedSource(url)).toThrow();
  });
  it("reads an Apple Music album from the public iTunes catalogue", async () => {
    vi.mocked(publicFetch).mockImplementation(async (url) => {
      expect(url).toContain("itunes.apple.com/lookup");
      expect(url).toContain("id=1440857781");
      expect(url).toContain("entity=song");
      expect(url).toContain("country=gb");
      return json({
        results: [
          {
            wrapperType: "collection",
            collectionName: "In Between Dreams",
          },
          {
            wrapperType: "track",
            kind: "song",
            trackName: "Better Together",
            artistName: "Jack Johnson",
            trackTimeMillis: 207679,
          },
          {
            wrapperType: "track",
            kind: "music-video",
            trackName: "Better Together (Video)",
            artistName: "Jack Johnson",
          },
        ],
      });
    });
    const result = await (
      await importLink(
        "https://music.apple.com/gb/album/in-between-dreams/1440857781",
      )
    ).json();
    expect(result.title).toBe("In Between Dreams");
    // Videos are not songs, and metadata carries names, never audio.
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({
      title: "Better Together",
      artist: "Jack Johnson",
      duration: 207.679,
    });
    expect(result.tracks[0].mediaUrl).toBeUndefined();
    // The YouTube match reports which service asked for it.
    expect(readTicket(result.tracks[0].matchTicket, "match").origin).toBe(
      "Apple Music",
    );
  });
  it("names the artist of every song in an Apple Music playlist", async () => {
    vi.mocked(publicFetch).mockImplementation(async (url) =>
      url.includes("itunes.apple.com")
        ? json({
            results: [
              {
                wrapperType: "track",
                kind: "song",
                trackId: 6822497774,
                trackName: "Housewife",
                artistName: "Tate McRae",
                trackTimeMillis: 208810,
              },
            ],
          })
        : new Response(
            `<script type="application/ld+json">${JSON.stringify({
              "@type": "MusicPlaylist",
              name: "Today’s Hits",
              author: { name: "Apple Music Hits" },
              track: [
                {
                  name: "Housewife",
                  url: "https://music.apple.com/us/song/housewife/6822497774",
                  duration: "PT3M28S",
                },
                { name: "Uncatalogued", duration: "PT1H2M3S" },
              ],
            })}</script>`,
          ),
    );
    const result = await (
      await importLink(
        "https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb",
      )
    ).json();
    expect(result.title).toBe("Today’s Hits");
    expect(result.tracks[0]).toMatchObject({
      title: "Housewife",
      artist: "Tate McRae",
      duration: 208.81,
    });
    // A song missing from the catalogue keeps its own title and length, and
    // is never credited to the playlist's curator.
    expect(result.tracks[1]).toMatchObject({
      title: "Uncatalogued",
      artist: "",
      duration: 3723,
    });
  });
  it("reads an Amazon Music album from the public music database", async () => {
    vi.mocked(publicFetch).mockImplementation(async (url) =>
      url.includes("/url/?resource=")
        ? json(
            url.includes("music.amazon.com/albums/B0CH3YL376")
              ? {
                  relations: [
                    {
                      "target-type": "release",
                      release: { id: "9c6bbc58", title: "Softly Spoken" },
                    },
                  ],
                }
              : { relations: [] },
          )
        : json({
            title: "Softly Spoken",
            "artist-credit": [{ name: "Glimlip" }],
            media: [
              {
                tracks: [
                  {
                    title: "Softly Spoken",
                    length: 138313,
                    "artist-credit": [
                      { name: "Glimlip", joinphrase: " & " },
                      { name: "azayaka" },
                    ],
                  },
                  { title: "Untitled credit", length: 90000 },
                ],
              },
            ],
          }),
    );
    const result = await (
      await importLink("https://music.amazon.com/albums/B0CH3YL376")
    ).json();
    expect(result.title).toBe("Softly Spoken");
    expect(result.tracks[0]).toMatchObject({
      title: "Softly Spoken",
      artist: "Glimlip & azayaka",
      duration: 138.313,
    });
    // A track without its own credit is the album's artist.
    expect(result.tracks[1].artist).toBe("Glimlip");
    expect(readTicket(result.tracks[1].matchTicket, "match").origin).toBe(
      "Amazon Music",
    );
  });
  it("finds an album catalogued under its Amazon product link", async () => {
    vi.mocked(publicFetch).mockImplementation(async (url) =>
      json(
        // Only the product link is catalogued, in the form the database
        // stores and looks up: /gp/product/, never /dp/.
        url.includes("/gp/product/B0CH3YL378")
          ? {
              relations: [
                {
                  "target-type": "release",
                  release: { id: "9c6bbc58", title: "A product album" },
                },
              ],
            }
          : url.includes("/url/?resource=")
            ? { relations: [] }
            : {
                title: "A product album",
                media: [{ tracks: [{ title: "Only track", length: 90000 }] }],
              },
      ),
    );
    const result = await (
      await importLink("https://music.amazon.com/albums/B0CH3YL378")
    ).json();
    expect(result.title).toBe("A product album");
    expect(result.tracks[0].title).toBe("Only track");
  });
  it("keeps a one-song Amazon Music link to that song", async () => {
    vi.mocked(publicFetch).mockImplementation(async (url) =>
      json(
        // The database lists the album but not the individual song.
        url.includes("/albums/") || url.includes("/gp/product/")
          ? {
              relations: [
                {
                  "target-type": "release",
                  release: { id: "9c6bbc58", title: "An album" },
                },
              ],
            }
          : { relations: [] },
      ),
    );
    const response = await importLink(
      "https://music.amazon.com/albums/B0CH3YL376?trackAsin=B0CH3YL999",
    );
    // The album is reachable, but one song was asked for.
    expect(response.status).toBe(422);
    expect((await response.json()).detail).toMatch(/without the song/);
  });
  it("spaces MusicBrainz requests even when imports overlap", async () => {
    const calls: number[] = [];
    vi.mocked(publicFetch).mockImplementation(async () => {
      calls.push(Date.now());
      return json({ relations: [] });
    });
    const start = Date.now();
    await Promise.all([
      importLink("https://music.amazon.com/albums/B0CH3YL371"),
      importLink("https://music.amazon.com/albums/B0CH3YL372"),
    ]);
    // Four lookups, each claiming its own second rather than firing together.
    expect(calls.length).toBe(4);
    for (const [index, time] of calls.entries())
      expect(time - start).toBeGreaterThanOrEqual(index * 1000 - 50);
  });
  it("says why an Amazon Music playlist cannot be imported", async () => {
    const response = await importLink(
      "https://music.amazon.com/playlists/B073H3G18R",
    );
    expect(response.status).toBe(422);
    expect((await response.json()).detail).toMatch(/sign-in/);
    expect(publicFetch).not.toHaveBeenCalled();
  });
  it("explains an Amazon Music album the public database does not list", async () => {
    vi.mocked(publicFetch).mockResolvedValue(json({ relations: [] }));
    const response = await importLink(
      "https://music.amazon.com/albums/B0CH3YL377",
    );
    expect(response.status).toBe(422);
    expect((await response.json()).detail).toMatch(/public music database/);
  });
});
describe("short-form sources", () => {
  it("opens a Short as the recording it is", () => {
    const short = allowedSource(
      "https://www.youtube.com/shorts/xKJtIjB3pAI?si=3ZN4Gzsw8cDL",
    );
    // One extraction path and one cache entry, whichever page it was on.
    expect(short.href).toBe("https://www.youtube.com/watch?v=xKJtIjB3pAI");
    // Anything that is not a video id is left for the extractor to reject,
    // as any other YouTube path is.
    expect(allowedSource("https://www.youtube.com/shorts/not-an-id").href).toBe(
      "https://www.youtube.com/shorts/not-an-id",
    );
  });
  it("accepts TikTok posts and rejects lookalikes", () => {
    for (const url of [
      "https://www.tiktok.com/@artist/video/7016181462140628225",
      "https://vm.tiktok.com/ZGJabcdef/",
      "https://tiktok.com/@artist/video/7016181462140628225",
    ])
      expect(providerFor(allowedSource(url))).toBe("TikTok");
    for (const url of [
      "https://tiktok.com.attacker.test/@artist/video/1",
      "http://www.tiktok.com/@artist/video/1",
    ])
      expect(() => allowedSource(url)).toThrow();
  });
  it("sends an IP-blocked post to the listener's own connection", async () => {
    const { extractionFailure } =
      await import("../src/server/extraction-error");
    const failure = extractionFailure(
      "ERROR: [TikTok] 7016181462140628225: Your IP address is blocked from accessing this post",
      false,
    );
    // The browser offers the desktop helper on exactly this wording.
    expect(failure.message).toMatch(/blocking requests from this web server/);
  });
});
describe("upload titles read as song names", () => {
  it("drops format tags, credit chains, and the artist before the dash", () => {
    const cases: [string, string, string, string][] = [
      // [upload title, uploader, song, artist]
      [
        "Shakira, Burna Boy - Dai Dai (Official Video)",
        "Shakira",
        "Dai Dai",
        "Shakira, Burna Boy",
      ],
      [
        "KALYANI (with Shreya Ghoshal) OFFICIAL MUSIC VIDEO | ARJN | KDS | FIFTY4",
        "MONEY VERSE RECORDS",
        "KALYANI (with Shreya Ghoshal)",
        "MONEY VERSE RECORDS",
      ],
      // What follows the dash is only a tag, so the name is what precedes it.
      [
        "Ala Bolelo – Lyric Video | Jailer 2 | Superstar Rajinikanth",
        "Sun TV",
        "Ala Bolelo",
        "Sun TV",
      ],
      [
        "A2O LITE 'NEON' Official Video",
        "A2O WORLD",
        "A2O LITE 'NEON'",
        "A2O WORLD",
      ],
      [
        "Olivia Rodrigo - expectations (feat. Chappell Roan) (Official Music Video)",
        "Olivia Rodrigo",
        "expectations (feat. Chappell Roan)",
        "Olivia Rodrigo",
      ],
      // Names that are already names are left alone.
      ["lofi hip hop radio", "ChilledCow", "lofi hip hop radio", "ChilledCow"],
      // Short first segments are names, not credits.
      ["Artist | Song", "Someone", "Artist | Song", "Someone"],
      [
        "Casa Tupka Anthemo | @YoYoHoneySingh | Full Video",
        "Yo Yo Honey Singh",
        "Casa Tupka Anthemo",
        "Yo Yo Honey Singh",
      ],
    ];
    for (const [title, uploader, song, artist] of cases)
      expect(songName(title, uploader)).toEqual({ title: song, artist });
  });
});
describe("service feeds", () => {
  const ask = async (provider: string, query?: string) =>
    feed(
      new Request("http://localhost/api/feed", {
        method: "POST",
        body: JSON.stringify({ provider, query }),
      }),
    );
  it("shows a service's own chart as importable rows", async () => {
    vi.mocked(extract).mockResolvedValue({
      title: "Top 100 Songs Global",
      entries: Array.from({ length: 30 }, (_, index) => ({
        id: `video${String(index).padStart(6, "0")}`,
        title: `Song ${index}`,
        channel: "An artist",
        duration: 200,
      })),
    });
    const result = await (await ask("YouTube")).json();
    expect(result.title).toBe("Top 100 Songs Global");
    // One screenful, each row already carrying its audio ticket.
    expect(result.tracks).toHaveLength(25);
    expect(result.tracks[0]).toMatchObject({
      title: "Song 0",
      artist: "An artist",
      mediaUrl: expect.stringMatching(/^\/api\/audio\?ticket=/),
    });
  });
  it("searches the services that publish one and says who does not", async () => {
    vi.mocked(publicFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              wrapperType: "track",
              kind: "song",
              trackName: "ocean eyes",
              artistName: "Billie Eilish",
              trackTimeMillis: 200000,
            },
          ],
        }),
      ),
    );
    const apple = await (await ask("Apple Music", "billie eilish")).json();
    expect(apple.title).toBe("billie eilish");
    expect(apple.tracks[0]).toMatchObject({
      title: "ocean eyes",
      artist: "Billie Eilish",
    });
    // Names, not audio: the match runs when the row is added.
    expect(apple.tracks[0].mediaUrl).toBeUndefined();
    expect(readTicket(apple.tracks[0].matchTicket, "match").origin).toBe(
      "Apple Music",
    );
    const spotify = await ask("Spotify", "billie eilish");
    expect(spotify.status).toBe(422);
    expect((await spotify.json()).detail).toMatch(/needs an account/);
  });
  it("skips search results that are live or have no usable link", async () => {
    vi.mocked(extract).mockResolvedValue({
      entries: [
        { id: "liveliveliv", title: "Radio", is_live: true, duration: 0 },
        { title: "No link here", duration: 100 },
        {
          webpage_url: "https://soundcloud.com/artist/track",
          title: "A set track",
          uploader: "Artist",
          duration: 150,
        },
      ],
    });
    const result = await (await ask("SoundCloud", "lofi")).json();
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0]).toMatchObject({
      title: "A set track",
      sourceUrl: "https://soundcloud.com/artist/track",
    });
  });
  it("says which services publish no chart and which have no feed at all", async () => {
    const soundcloud = await ask("SoundCloud");
    expect(soundcloud.status).toBe(422);
    expect((await soundcloud.json()).detail).toMatch(/no public chart/);
    const amazon = await ask("Amazon Music", "anything");
    expect(amazon.status).toBe(400);
    expect(extract).not.toHaveBeenCalled();
    expect(publicFetch).not.toHaveBeenCalled();
  });
  it("serves a repeated feed from memory instead of asking again", async () => {
    vi.mocked(extract).mockResolvedValue({
      entries: [
        {
          id: "cachedvideo",
          title: "Cached song",
          channel: "An artist",
          duration: 180,
        },
      ],
    });
    const first = await (await ask("YouTube", "a cached query")).json();
    const again = await (await ask("YouTube", "a cached query")).json();
    expect(again.tracks[0].title).toBe(first.tracks[0].title);
    expect(extract).toHaveBeenCalledTimes(1);
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
