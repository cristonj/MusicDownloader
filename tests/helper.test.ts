import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { startHelper } from "../helper/server";
vi.mock("../src/server/extractor", () => ({
  extract: vi.fn(async (url: string) =>
    url.startsWith("ytsearch")
      ? {
          entries: [
            {
              id: "abcdefghijk",
              title: "An artist - A song",
              channel: "An artist",
              duration: 180,
            },
          ],
        }
      : {
          title: "A song",
          artist: "An artist",
          duration: 180,
          ext: "m4a",
          webpage_url: url,
        },
  ),
  extractUsingClient: vi.fn(),
  invalidateExtraction: vi.fn(),
  rememberExtraction: vi.fn(),
}));
vi.mock("../src/server/spotify", () => ({
  spotifyMetadata: vi.fn(async () => ({
    title: "Playlist",
    tracks: [{ title: "A song", artist: "An artist", duration: 180 }],
  })),
}));
const origin = "https://musicdownloaderapp.netlify.app",
  token = "a".repeat(43);
let server: Server, base: string;
beforeAll(async () => {
  server = await startHelper({
    token,
    origin,
    port: 0,
    state: () => ({ ready: true }),
  });
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
const call = (path: string, init: RequestInit = {}) =>
  fetch(base + path, {
    ...init,
    headers: {
      Origin: origin,
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
describe("desktop helper", () => {
  it("serves discovery searches on the local API", async () => {
    const response = await call("/api/feed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "YouTube",
        query: "An artist",
        size: 3,
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).tracks[0].title).toBe("A song");
  });
  it("allows only the paired app and token, with private-network preflight support", async () => {
    expect((await call("/health")).status).toBe(200);
    expect(
      (await call("/health", { headers: { Origin: "https://attacker.test" } }))
        .status,
    ).toBe(403);
    expect(
      (await call("/health", { headers: { Authorization: "Bearer wrong" } }))
        .status,
    ).toBe(401);
    const preflight = await call("/api/resolve", { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-private-network")).toBe(
      "true",
    );
  });
  it.each([
    "https://music.youtube.com/watch?v=xKJtIjB3pAI&si=example",
    "https://soundcloud.com/artist/track",
    "https://artist.bandcamp.com/album/example",
    "https://open.spotify.com/playlist/1234567890123456789012",
  ])("handles %s on the local source path", async (url) => {
    const response = await call("/api/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.tracks).toHaveLength(1);
    if (result.tracks[0].matchTicket) {
      const match = await call("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket: result.tracks[0].matchTicket }),
      });
      expect(match.status).toBe(200);
      expect((await match.json()).sourceUrl).toBe(
        "https://www.youtube.com/watch?v=abcdefghijk",
      );
    } else expect(result.tracks[0].mediaUrl).toMatch(/^\/api\/audio\?ticket=/);
  });
  it("rejects arbitrary hosts even from an authenticated app", async () => {
    expect(
      (
        await call("/api/resolve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: "https://localhost/private" }),
        })
      ).status,
    ).toBe(400);
  });
});
