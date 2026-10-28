import { test, expect } from "@playwright/test";
import { open, unlink, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { demoFile } from "../fixture";

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
  const track = await toggle.boundingBox(),
    thumb = await toggle.locator("span").boundingBox();
  expect(thumb!.x).toBeGreaterThan(track!.x + 18);
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
