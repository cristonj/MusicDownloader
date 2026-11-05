import { test, expect } from "@playwright/test";
import { open, unlink, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { demoFile } from "../fixture";

test("failed background feed matches can be retried without reloading the feed", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("music-downloader:preferences",
    JSON.stringify({ feed: true, feedHidden: ["YouTube", "Apple Music", "SoundCloud"] })));
  await page.route("**/api/feed", (route) => route.fulfill({ json: {
    title: "Chart", tracks: [{ title: "Retry song", artist: "Artist", matchTicket: "retry-ticket" }],
  } }));
  let release!: () => void;
  const waiting = new Promise<void>((done) => { release = done; });
  let matches = 0;
  await page.route("**/api/match", async (route) => {
    matches++;
    if (matches === 1) {
      await waiting;
      await route.fulfill({ status: 503, json: { detail: "Matching temporarily unavailable" } });
    } else await route.fulfill({ json: {
      title: "Retry song", mediaUrl: "/api/audio?ticket=recovered",
      sourceUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    } });
  });
  await page.goto("/");
  const add = page.getByRole("button", { name: "Add Retry song from Spotify", exact: true });
  await add.click();
  await expect(page.locator(".track-row")).toContainText("Finding audio");
  await expect(add).toBeDisabled();
  release();
  await expect(page.locator(".track-row")).toContainText("Matching temporarily unavailable");
  await expect(add).toBeEnabled();
  await page.getByRole("button", { name: "Remove Retry song", exact: true }).click();
  await add.click();
  await expect(page.locator(".track-row")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Download Retry song", exact: true })).toBeEnabled();
  await expect(add).toBeDisabled();
  expect(matches).toBe(2);
});

test("extension setup explains installation, copies pairing details, and shows session connection", async ({ page, context }) => {
  const token = "e".repeat(43);
  let paired = false;
  const directory = "C:\\Users\\Listener\\.musicdownloader\\browser-extension";
  const code = "45821." + "a".repeat(32);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/api/helper-release", (route) => route.fulfill({ json: { windows: true } }));
  await page.route("http://127.0.0.1:45821/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const headers = {
      "Access-Control-Allow-Origin": request.headers().origin || "http://localhost:3000",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    expect(request.headers().authorization).toBe(`Bearer ${token}`);
    let value: unknown = {};
    if (path === "/health") value = { app: "MusicDownloader", version: 10, ready: true };
    if (path === "/accounts") value = { accounts: paired ? { youtube: "extension" } : {} };
    if (path === "/extension/status") value = { paired, services: paired ? { youtube: { updated: Date.now(), expires: Date.now() + 900000 } } : {} };
    if (path === "/extension/setup") {
      expect(request.postDataJSON()).toEqual({ browser: "edge" });
      value = { code, directory, opened: true, expires: Date.now() + 300000 };
    }
    if (path === "/extension/disconnect") paired = false;
    await route.fulfill({ json: value, headers });
  });
  await page.goto(`http://localhost:3000/#helper_token=${token}&helper_port=45821`);
  await expect(page.getByText("Connected. Ready to download.")).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Sign in for better audio", exact: true }).click();
  await page.getByLabel("Extension browser").selectOption("edge");
  await page.getByRole("button", { name: "Set up browser extension", exact: true }).click();
  await expect(page.locator(".extension-setup")).toContainText("Load unpacked");
  await expect(page.locator(".extension-setup")).toContainText(directory);
  await page.getByRole("button", { name: "Copy pairing code", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
  paired = true;
  await expect(page.locator(".extension-setup")).toContainText("Sessions synced: YouTube Music.");
  await page.getByRole("button", { name: "Disconnect extension", exact: true }).click();
  await expect(page.locator(".extension-setup")).toContainText("Shared sessions removed.");
  expect(paired).toBe(false);
});

test("large local originals exceed the former file and collection caps", async ({
  page,
}) => {
  const size = 160 * 1024 * 1024;
  const paths = [1, 2, 3].map((i) => resolve(`.server/large-${i}.wav`));
  try {
    for (const path of paths) {
      const file = await open(path, "w");
      await file.write(Buffer.from("RIFF-large-original"));
      await file.truncate(size);
      await file.close();
    }
    await page.goto("/");
    await expect(page.getByLabel("Output format")).toBeEnabled();
    await page.getByLabel("Output format").selectOption("original");
    await page.locator("input[type=file]").setInputFiles(paths);
    await expect(page.locator(".track-row")).toHaveCount(3);
    await expect(page.locator(".notice[role=alert]")).toHaveCount(0);
    const waiting = page.waitForEvent("download");
    await page.locator(".track-download").first().click();
    const download = await waiting;
    expect(await download.failure()).toBeNull();
    expect((await stat((await download.path())!)).size).toBe(size);
    const saved = await open((await download.path())!, "r");
    const bytes = Buffer.alloc(Buffer.byteLength("RIFF-large-original"));
    await saved.read(bytes, 0, bytes.length, 0);
    await saved.close();
    expect(bytes.toString()).toBe("RIFF-large-original");
    const packing = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download ZIP" }).click();
    const archive = await packing;
    expect(await archive.failure()).toBeNull();
    const archivePath = (await archive.path())!;
    const archiveSize = (await stat(archivePath)).size;
    expect(archiveSize).toBeGreaterThan(size * 3);
    const zip = await open(archivePath, "r");
    const end = Buffer.alloc(22);
    await zip.read(end, 0, 22, archiveSize - 22);
    await zip.close();
    expect(end.readUInt32LE(0)).toBe(0x06054b50);
    expect(end.readUInt16LE(10)).toBe(3);
  } finally {
    for (const path of paths) await unlink(path).catch(() => {});
  }
});

test("discovery switches preserve completed audio and stay aligned on mobile", async ({
  page,
}, info) => {
  await page.route("**/api/feed", (route) =>
    route.fulfill({
      json: {
        title: "Chart",
        tracks: [{ title: "A song", artist: "An artist" }],
      },
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByLabel("Output format")).toBeEnabled();
  await page.locator("input[type=file]").setInputFiles({
    name: "Cached.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from(await demoFile().arrayBuffer()),
  });
  const waiting = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download track", exact: true })
    .click();
  await waiting;
  await expect(page.locator(".done-label")).toHaveText("Ready");
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Show service feeds" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(async () => {
      const track = await toggle.boundingBox(),
        thumb = await toggle.locator("span").boundingBox();
      return thumb!.x - track!.x;
    })
    .toBeGreaterThan(18);
  const track = await toggle.boundingBox(),
    thumb = await toggle.locator("span").boundingBox();
  expect(thumb!.x + thumb!.width).toBeLessThanOrEqual(track!.x + track!.width);
  await page.screenshot({ path: info.outputPath("mobile-settings.png") });
  await page.keyboard.press("Escape");
  await expect(page.locator(".done-label")).toHaveText("Ready");
  await page.getByRole("button", { name: "Hide YouTube", exact: true }).click();
  await expect(page.locator(".done-label")).toHaveText("Ready");
  await page.reload();
  await expect(page.locator(".feed-card")).toHaveCount(3);
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect(page.locator(".feed")).toHaveCount(0);
});

test("discovery repeats searches and refreshes hidden services when revealed", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "music-downloader:preferences",
      JSON.stringify({ feed: true }),
    ),
  );
  let requests = 0;
  await page.route("**/api/feed", async (route) => {
    requests++;
    const { provider, query } = route.request().postDataJSON();
    await route.fulfill({
      json: {
        title: query || "Chart",
        tracks: [
          { title: `${provider} ${query || "chart"}`, artist: "Artist" },
        ],
      },
    });
  });
  await page.goto("/");
  await expect(
    page.getByText("Apple Music chart", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Hide Apple Music", exact: true })
    .click();
  await page.getByLabel("Search every service").fill("new search");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByText("YouTube new search", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("region", { name: "Service feeds" })
    .getByRole("button", { name: "Apple Music", exact: true })
    .click();
  await expect(
    page.getByText("Apple Music new search", { exact: true }),
  ).toBeVisible();
  const before = requests;
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect.poll(() => requests).toBeGreaterThan(before);
  await expect(
    page.getByText("Apple Music new search", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".feed-skeletons")).toHaveCount(0);
});

test("a track's source can be compared and changed", async ({ page }, info) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "music-downloader:preferences",
      JSON.stringify({ feed: true, feedHidden: ["YouTube", "Spotify", "Apple Music"] }),
    ),
  );
  await page.route("**/api/feed", (route) =>
    route.fulfill({
      json: {
        title: "Trending: All Genres",
        tracks: [
          {
            title: "A song",
            artist: "An artist",
            mediaUrl: "/api/audio?ticket=first",
            sourceUrl: "https://soundcloud.com/an-artist/a-song",
            fallbackTicket: "names",
          },
        ],
      },
    }),
  );
  await page.route("**/api/sources", (route) =>
    route.fulfill({
      json: {
        options: [
          {
            provider: "YouTube",
            matchedTitle: "A song (Official Audio)",
            matchedChannel: "An artist",
            matchConfidence: 1,
            mediaUrl: "/api/audio?ticket=second",
            sourceUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
            extension: "webm",
            codec: "opus",
            bitrateKbps: 165,
            sampleRate: 48000,
          },
          {
            provider: "SoundCloud",
            matchedTitle: "A song",
            mediaUrl: "/api/audio?ticket=first",
            sourceUrl: "https://soundcloud.com/an-artist/a-song",
            extension: "m4a",
            codec: "aac",
            bitrateKbps: 160,
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await expect(page.getByText("Trending: All Genres", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Add A song from SoundCloud" }).click();
  await page.getByRole("button", { name: "Change source for A song" }).click();
  await expect(page.getByText("Highest bitrate here")).toBeVisible();
  await expect(page.getByRole("button", { name: "In use" })).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("source-picker.png"), fullPage: true });
  await page.getByRole("button", { name: "Use", exact: true }).click();
  await expect(page.getByText("Source: YouTube", { exact: false })).toBeVisible();
  await expect(page.getByText("Match: A song (Official Audio)", { exact: false })).toBeVisible();
});
