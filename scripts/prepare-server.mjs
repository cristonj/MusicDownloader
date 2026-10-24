// Build-time tools are private server assets, never served from public/.
import { mkdir, readFile, writeFile, chmod, access } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { fetch, EnvHttpProxyAgent } from "undici";
const directory = new URL("../.server/", import.meta.url);
await mkdir(directory, { recursive: true });
try {
  await access(new URL("key", directory));
} catch {
  await writeFile(new URL("key", directory), randomBytes(32).toString("hex"), {
    mode: 0o644,
  });
}
// Deployment archives must remain readable by the hosting runtime user.
await chmod(new URL("key", directory), 0o644);
const version = "2026.10.21";
const names = {
  "linux-x64": "yt-dlp_linux",
  "linux-arm64": "yt-dlp_linux_aarch64",
  "darwin-x64": "yt-dlp_macos",
  "darwin-arm64": "yt-dlp_macos",
  "win32-x64": "yt-dlp.exe",
};
const name = names[`${process.platform}-${process.arch}`];
if (!name)
  throw new Error(
    `Unsupported server platform: ${process.platform}-${process.arch}`,
  );
const destination = new URL(
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
  directory,
);
const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}`;
const dispatcher =
  process.env.HTTPS_PROXY || process.env.HTTP_PROXY
    ? new EnvHttpProxyAgent()
    : undefined;
async function download(file) {
  const response = await fetch(`${base}/${file}`, {
    dispatcher,
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok)
    throw new Error(
      `Could not download bundled media tool (${response.status}).`,
    );
  return Buffer.from(await response.arrayBuffer());
}
try {
  const existing = JSON.parse(
    await readFile(new URL("version.json", directory), "utf8"),
  );
  if (existing.version === version && existing.name === name) {
    const bytes = await readFile(destination);
    if (createHash("sha256").update(bytes).digest("hex") === existing.sha256)
      process.exit(0);
  }
} catch {
  /* Fresh checkout: install the pinned standalone tool. */
}
const sums = (await download("SHA2-256SUMS")).toString("utf8");
const expected = sums
  .split("\n")
  .map((line) => line.trim().split(/\s+/))
  .find((parts) => parts[1]?.replace(/^\*/, "") === name)?.[0];
if (!expected || !/^[0-9a-f]{64}$/i.test(expected))
  throw new Error("Could not verify the media tool checksum.");
const bytes = await download(name);
if (createHash("sha256").update(bytes).digest("hex") !== expected)
  throw new Error("Media tool checksum mismatch.");
await writeFile(destination, bytes);
await chmod(destination, 0o755);
await writeFile(
  new URL("version.json", directory),
  JSON.stringify({ version, name, sha256: expected }),
);
await dispatcher?.close();
console.log("Bundled media tool ready.");
