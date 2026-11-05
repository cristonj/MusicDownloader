import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
describe("the app served from this computer", () => {
  let local: Server, url: string, root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "music-app-"));
    await mkdir(join(root, "app", "_next", "static"), { recursive: true });
    await writeFile(join(root, "app", "index.html"), "<html>app</html>");
    await writeFile(join(root, "app", "_next", "static", "a.js"), "1");
    await writeFile(join(root, "secret.js"), "secret");
    await writeFile(join(root, "app", "notes.md"), "not a served type");
    local = await startHelper({
      token,
      origin,
      port: 0,
      state: () => ({ ready: true }),
      appDir: join(root, "app"),
    });
    const address = local.address();
    url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => local.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  it("serves the page and assets, and nothing outside them", async () => {
    const page = await fetch(url + "/");
    expect(await page.text()).toBe("<html>app</html>");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(
      (await fetch(url + "/_next/static/a.js")).headers.get("cache-control"),
    ).toMatch(/immutable/);
    for (const path of ["/notes.md", "/..%2fsecret.js", "/%2e%2e/secret.js"])
      expect((await fetch(url + path)).status).toBe(404);
    const health = (headers: Record<string, string>) =>
      fetch(url + "/health", {
        headers: { Authorization: `Bearer ${token}`, ...headers },
      });
    // The API stays behind the token, the Origin rules, and same-origin only.
    expect((await fetch(url + "/health")).status).toBe(403);
    expect((await health({ Origin: url })).status).toBe(200);
    expect((await health({ "Sec-Fetch-Site": "same-origin" })).status).toBe(
      200,
    );
    expect((await health({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await health({ Origin: "https://attacker.test" })).status).toBe(
      403,
    );
    expect(
      (
        await fetch(url + "/health", {
          headers: { Origin: url, Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
  });
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
