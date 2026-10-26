import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { unzipSync } from "fflate";
import { demoFile } from "../fixture";

test("local conversion creates real audio in every format without uploading", async ({
  page,
}) => {
  const external: string[] = [];
  page.on("request", (r) => {
    if (
      !r.url().startsWith("http://127.0.0.1:3000") &&
      !r.url().startsWith("blob:")
    )
      external.push(r.url());
  });
  await page.goto("/");
  await expect(page.getByLabel("Output format")).toBeEnabled();
  await page.locator("input[type=file]").setInputFiles({
    name: "Sunday morning.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from(await demoFile().arrayBuffer()),
  });
  await expect(page.getByText("Sunday morning", { exact: true })).toBeVisible();
  const formats = {
    original: "pcm_s16le",
    mp3: "mp3",
    m4a: "aac",
    flac: "flac",
    wav: "pcm_s16le",
    ogg: "vorbis",
    opus: "opus",
    aiff: "pcm_s16be",
  };
  for (const [format, codec] of Object.entries(formats)) {
    await page.getByLabel("Output format").selectOption(format);
    const waiting = page.waitForEvent("download", { timeout: 20_000 });
    await page
      .getByRole("button", { name: "Download track", exact: true })
      .click();
    const download = await waiting;
    const path = await download.path();
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toBe(
      `Sunday morning.${format === "original" ? "wav" : format}`,
    );
    const probe = JSON.parse(
      execFileSync(
        "ffprobe",
        ["-v", "error", "-show_streams", "-of", "json", path!],
        { encoding: "utf8" },
      ),
    );
    expect(probe.streams[0].codec_name).toBe(codec);
    expect(Number(probe.streams[0].sample_rate)).toBeGreaterThanOrEqual(44100);
    await expect(
      page.getByRole("button", { name: "Download track", exact: true }),
    ).toBeEnabled();
  }
  expect(external).toEqual([]);
});

test("ZIP preserves duplicate filenames and original bytes", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Output format").selectOption("original");
  await expect(page.getByLabel("Output format")).toBeEnabled();
  await page.locator("input[type=file]").setInputFiles({
    name: "Sunday morning.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from(await demoFile().arrayBuffer()),
  });
  const waiting = page.waitForEvent("download", { timeout: 20_000 });
  await page
    .getByRole("button", { name: "Download track", exact: true })
    .click();
  const source = await waiting;
  const original = await readFile((await source.path())!);
  await page
    .locator("input[type=file]")
    .setInputFiles([
      { name: "Sunday morning.wav", mimeType: "audio/wav", buffer: original },
    ]);
  const zipped = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download ZIP" }).click();
  const archive = await zipped;
  const files = unzipSync(await readFile((await archive.path())!));
  expect(Object.keys(files)).toEqual([
    "Sunday morning.wav",
    "Sunday morning (2).wav",
  ]);
  for (const bytes of Object.values(files))
    expect(Buffer.from(bytes).equals(original)).toBe(true);
});

test("Spotify matches are shown and unmatched entries are retained", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "music-downloader:preferences",
      JSON.stringify({
        format: "original",
      }),
    ),
  );
  await page.route("**/api/resolve", (route) =>
    route.fulfill({
      json: {
        title: "His playlist",
        tracks: [
          {
            title: "A favorite",
            artist: "An artist",
            extension: "m4a",
            duration: 180,
            mediaUrl: "/api/audio?ticket=signed",
            sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
            matchedTitle: "An artist — A favorite (Official audio)",
            matchConfidence: 0.99,
          },
          {
            title: "Missing recording",
            artist: "An artist",
            error: "No close audio match found.",
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await page
    .getByLabel("Music or playlist link")
    .fill("https://open.spotify.com/playlist/1234567890123456789012");
  await page.getByRole("button", { name: "Add music link" }).click();
  await expect(page.getByText("A favorite", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Match:/ })).toHaveAttribute(
    "href",
    "https://www.youtube.com/watch?v=abcdefghijk",
  );
  await expect(
    page.getByLabel("Select A favorite", { exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByLabel("Select Missing recording", { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("No close audio match found.", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Select A favorite", { exact: true }).check();
  await expect(
    page.getByRole("button", { name: "Download track", exact: true }),
  ).toBeEnabled();
});

test("errors are actionable and settings persist", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Music or playlist link").fill("not a link");
  await page.getByRole("button", { name: "Add music link" }).click();
  await expect(page.locator(".notice[role=alert]")).toContainText(
    "complete https://",
  );
  await page.getByLabel("Output format").selectOption("flac");
  await page.reload();
  await expect(page.getByLabel("Output format")).toHaveValue("flac");
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toContainText(
    /resolver|service imports|connection/i,
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("minimal screen fits desktop and mobile", async ({ page }, info) => {
  await page.goto("/");
  await page.screenshot({
    path: info.outputPath("desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Music or playlist link")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("mobile.png"),
    fullPage: true,
  });
});

test("24-bit WAV export honors the selected sample rate", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Output format")).toBeEnabled();
  await page.locator("input[type=file]").setInputFiles({
    name: "Quality.wav",
    mimeType: "audio/wav",
    buffer: Buffer.from(await demoFile().arrayBuffer()),
  });
  await page.getByLabel("Output format").selectOption("wav");
  await page.getByLabel("Bit depth").selectOption("24");
  await page.getByRole("button", { name: "Preferences", exact: true }).click();
  await page.getByLabel("Sample rate", { exact: true }).selectOption("96000");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const waiting = page.waitForEvent("download", { timeout: 20_000 });
  await page
    .getByRole("button", { name: "Download track", exact: true })
    .click();
  const download = await waiting;
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_streams", "-of", "json", (await download.path())!],
      { encoding: "utf8" },
    ),
  );
  expect(probe.streams[0].sample_rate).toBe("96000");
  expect(probe.streams[0].codec_name).toBe("pcm_s24le");
});

test("source failure keeps successful ZIP tracks and the true original extension", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "music-downloader:preferences",
      JSON.stringify({
        format: "original",
      }),
    ),
  );
  await page.route("**/api/resolve", (route) =>
    route.fulfill({
      json: {
        title: "Two songs",
        tracks: [
          {
            title: "Good track",
            mediaUrl: "/api/audio?ticket=good",
            extension: "m4a",
          },
          {
            title: "Unavailable track",
            mediaUrl: "/api/audio?ticket=bad",
            extension: "m4a",
          },
        ],
      },
    }),
  );
  const wav = Buffer.from(await demoFile().arrayBuffer());
  await page.route("**/api/audio?ticket=good", (route) =>
    route.fulfill({
      json: { extension: "wav", parts: ["/api/media?ticket=good"] },
    }),
  );
  await page.route("**/api/media?ticket=good", (route) =>
    route.fulfill({
      status: 206,
      body: wav,
      contentType: "audio/wav",
      headers: {
        "Content-Range": `bytes 0-${wav.length - 1}/${wav.length}`,
        "X-Audio-More": "0",
      },
    }),
  );
  await page.route("**/api/audio?ticket=bad", (route) =>
    route.fulfill({ status: 410, json: { detail: "This link expired." } }),
  );
  await page.goto("/");
  await page
    .getByLabel("Music or playlist link")
    .fill("https://www.youtube.com/playlist?list=test");
  await page.getByRole("button", { name: "Add music link" }).click();
  const waiting = page.waitForEvent("download", { timeout: 20_000 });
  await page.getByRole("button", { name: "Download ZIP", exact: true }).click();
  const download = await waiting;
  const files = unzipSync(await readFile((await download.path())!));
  expect(Object.keys(files)).toEqual(["Good track.wav"]);
  expect(Buffer.from(files["Good track.wav"]).equals(wav)).toBe(true);
  await expect(page.locator(".notice[role=alert]")).toContainText(
    "1 track(s) failed",
  );
  await expect(
    page.getByText("This link expired.", { exact: false }),
  ).toBeVisible();
});

test("large service downloads use parallel bounded chunks with no setup", async ({
  page,
}) => {
  const source = Buffer.alloc(7 * 1024 * 1024 + 17);
  for (let i = 0; i < source.length; i++) source[i] = i % 251;
  await page.route("**/api/resolve", (route) =>
    route.fulfill({
      json: {
        title: "A track",
        tracks: [
          {
            title: "Large track",
            mediaUrl: "/api/audio?ticket=large",
            extension: "wav",
          },
        ],
      },
    }),
  );
  await page.route("**/api/audio?ticket=large", (route) =>
    route.fulfill({
      json: { extension: "wav", parts: ["/api/media?ticket=large"] },
    }),
  );
  let active = 0,
    peak = 0;
  await page.route("**/api/media?ticket=large", async (route) => {
    const match = route
      .request()
      .headers()
      .range.match(/bytes=(\d+)-(\d+)/)!;
    const start = Number(match[1]),
      end = Math.min(Number(match[2]), source.length - 1);
    expect(end - start + 1).toBeLessThanOrEqual(2 * 1024 * 1024);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, (start % 3) * 15 + 30));
    await route.fulfill({
      status: 206,
      body: source.subarray(start, end + 1),
      contentType: "audio/wav",
      headers: {
        "Content-Range": `bytes ${start}-${end}/${source.length}`,
        "X-Audio-More": end + 1 < source.length ? "1" : "0",
      },
    });
    active--;
  });
  await page.goto("/");
  await page
    .getByLabel("Music or playlist link")
    .fill("https://artist.bandcamp.com/track/example");
  await page.getByRole("button", { name: "Add music link" }).click();
  await expect(page.getByText("Large track", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const waiting = page.waitForEvent("download", { timeout: 20000 });
  await page
    .getByRole("button", { name: "Download track", exact: true })
    .click();
  const result = await waiting;
  expect((await readFile((await result.path())!)).equals(source)).toBe(true);
  expect(peak).toBeGreaterThanOrEqual(2);
});

test("Original HLS audio is assembled and remuxed locally without transcoding", async ({
  page,
}) => {
  const wav = Buffer.from(await demoFile().arrayBuffer());
  const stream = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", "pipe:0", "-c:a", "aac", "-f", "mpegts", "pipe:1"],
    { input: wav },
  );
  await page.route("**/api/resolve", (route) =>
    route.fulfill({
      json: {
        title: "HLS track",
        tracks: [
          {
            title: "HLS track",
            mediaUrl: "/api/audio?ticket=hls",
            extension: "m4a",
          },
        ],
      },
    }),
  );
  await page.route("**/api/audio?ticket=hls", (route) =>
    route.fulfill({
      json: {
        extension: "ts",
        remuxTo: "m4a",
        parts: ["/api/media?ticket=hls"],
      },
    }),
  );
  await page.route("**/api/media?ticket=hls", (route) =>
    route.fulfill({
      status: 206,
      body: stream,
      contentType: "video/mp2t",
      headers: {
        "Content-Range": `bytes 0-${stream.length - 1}/${stream.length}`,
        "X-Audio-More": "0",
      },
    }),
  );
  await page.goto("/");
  await page
    .getByLabel("Music or playlist link")
    .fill("https://soundcloud.com/artist/track");
  await page.getByRole("button", { name: "Add music link" }).click();
  const waiting = page.waitForEvent("download", { timeout: 20000 });
  await page
    .getByRole("button", { name: "Download track", exact: true })
    .click();
  const result = await waiting;
  expect(result.suggestedFilename()).toBe("HLS track.m4a");
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_streams", "-of", "json", (await result.path())!],
      { encoding: "utf8" },
    ),
  );
  expect(probe.streams[0].codec_name).toBe("aac");
  expect(Number(probe.streams[0].duration)).toBeGreaterThan(4.9);
});

test("desktop helper wizard pairs and downloads without using the hosted source API", async ({
  page,
}) => {
  const token = "a".repeat(43),
    wav = Buffer.from(await demoFile().arrayBuffer());
  let hostedSourceRequests = 0,
    localSourceRequests = 0;
  await page.route("**/api/helper-release", (route) =>
    route.fulfill({ json: { windows: true, mac: true, linux: true } }),
  );
  await page.route("http://127.0.0.1:45821/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const headers = {
      "Access-Control-Allow-Origin": "http://127.0.0.1:3000",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Expose-Headers": "Content-Range, X-Audio-More",
    };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    expect(request.headers().authorization).toBe(`Bearer ${token}`);
    if (path === "/health")
      await route.fulfill({
        json: { app: "MusicDownloader", version: 3, ready: true },
        headers,
      });
    else if (path === "/api/resolve") {
      localSourceRequests++;
      await route.fulfill({
        json: {
          title: "On this computer",
          tracks: [
            {
              title: "Local connection",
              mediaUrl: "/api/audio?ticket=local",
              extension: "wav",
            },
          ],
        },
        headers,
      });
    } else if (path === "/api/audio")
      await route.fulfill({
        json: { extension: "wav", parts: ["/api/media?ticket=local"] },
        headers,
      });
    else
      await route.fulfill({
        status: 206,
        body: wav,
        contentType: "audio/wav",
        headers: {
          ...headers,
          "Content-Range": `bytes 0-${wav.length - 1}/${wav.length}`,
          "X-Audio-More": "0",
        },
      });
  });
  await page.route("http://127.0.0.1:3000/api/resolve", (route) => {
    hostedSourceRequests++;
    return route.abort();
  });
  await page.goto(`/#helper_token=${token}&helper_port=45821`);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText("Connected. Ready to download.")).toBeVisible();
  await expect(page).not.toHaveURL(/helper_token/);
  await page.getByLabel("Helper operating system").selectOption("windows");
  await expect(
    page.getByRole("link", { name: "Download helper .exe" }),
  ).toHaveAttribute("href", /MusicDownloader-Helper-Windows.exe$/);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page
    .getByLabel("Music or playlist link")
    .fill("https://music.youtube.com/watch?v=xKJtIjB3pAI");
  await page.getByRole("button", { name: "Add music link" }).click();
  await expect(
    page.getByText("Local connection", { exact: true }),
  ).toBeVisible();
  const waiting = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download track", exact: true })
    .click();
  const file = await waiting;
  expect((await readFile((await file.path())!)).equals(wav)).toBe(true);
  expect(localSourceRequests).toBe(1);
  expect(hostedSourceRequests).toBe(0);
});
