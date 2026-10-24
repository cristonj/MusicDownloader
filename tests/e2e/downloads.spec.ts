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
  await page
    .locator("input[type=file]")
    .setInputFiles({
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
  await page
    .locator("input[type=file]")
    .setInputFiles({
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
        resolverUrl: "https://resolver.test",
        format: "original",
      }),
    ),
  );
  await page.route("https://resolver.test/resolve", (route) =>
    route.fulfill({
      json: {
        title: "His playlist",
        tracks: [
          {
            title: "A favorite",
            artist: "An artist",
            extension: "m4a",
            duration: 180,
            mediaUrl: "/media/signed",
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
  await expect(
    page.getByRole("link", { name: /YouTube match/ }),
  ).toHaveAttribute("href", "https://www.youtube.com/watch?v=abcdefghijk");
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
  await page
    .getByLabel("Music or playlist link")
    .fill("https://www.youtube.com/watch?v=abcdefghijk");
  await page.getByRole("button", { name: "Add music link" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".notice[role=alert]")).toContainText(
    "Connect a resolver",
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
  await page
    .locator("input[type=file]")
    .setInputFiles({
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
        resolverUrl: "https://resolver.test",
        format: "original",
      }),
    ),
  );
  await page.route("https://resolver.test/resolve", (route) =>
    route.fulfill({
      json: {
        title: "Two songs",
        tracks: [
          { title: "Good track", mediaUrl: "/media/good", extension: "m4a" },
          {
            title: "Unavailable track",
            mediaUrl: "/media/bad",
            extension: "m4a",
          },
        ],
      },
    }),
  );
  const wav = Buffer.from(await demoFile().arrayBuffer());
  await page.route("https://resolver.test/media/good", (route) =>
    route.fulfill({
      body: wav,
      contentType: "audio/wav",
      headers: { "X-Audio-Extension": "wav" },
    }),
  );
  await page.route("https://resolver.test/media/bad", (route) =>
    route.fulfill({ status: 410, body: "" }),
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
