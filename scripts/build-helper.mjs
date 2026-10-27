import { build } from "esbuild";
import { mkdir, writeFile, cp, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { writeIcon } from "./make-icon.mjs";
const platform = process.argv[2] || process.platform,
  arch = process.argv[3] || process.arch;
await import("./prepare-server.mjs");
const target = `node22-${platform === "win32" ? "win" : platform === "darwin" ? "macos" : "linux"}-${arch}`;
await mkdir(".helper-build", { recursive: true });
await mkdir("helper-dist", { recursive: true });
await mkdir(".helper-build/assets", { recursive: true });
await cp(
  `.server/${process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"}`,
  `.helper-build/assets/${process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"}`,
);
await cp(".server/version.json", ".helper-build/assets/version.json");
await writeFile(
  ".helper-build/pkg.json",
  JSON.stringify({ pkg: { assets: ["assets/**/*"] } }),
);
await build({
  entryPoints: ["helper/main.ts"],
  outfile: ".helper-build/main.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minify: false,
  logLevel: "warning",
});
const filename = `MusicDownloader-Helper-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
execFileSync(
  process.execPath,
  [
    "node_modules/@yao-pkg/pkg/lib-es5/bin.js",
    ".helper-build/main.cjs",
    "--config",
    ".helper-build/pkg.json",
    "--targets",
    target,
    "--output",
    `helper-dist/${filename}`,
    "--no-bytecode",
    "--public-packages",
    "*",
    "--public",
    // Shrinks the packaged download; the runtime unpacks it in memory.
    "--compress",
    "Brotli",
  ],
  { stdio: "inherit", env: process.env },
);
const icon = await writeIcon(".helper-build/app.ico");
// A Windows application carries its own icon and version, rather than the
// runtime's. rcedit only runs on Windows; elsewhere the icon is still built
// for the installer.
if (platform === "win32" && process.platform === "win32")
  try {
    execFileSync(
      process.execPath,
      [
        "node_modules/rcedit/bin/rcedit.js",
        `helper-dist/${filename}`,
        "--set-icon",
        icon,
        "--set-version-string",
        "ProductName",
        "MusicDownloader Helper",
        "--set-version-string",
        "FileDescription",
        "MusicDownloader desktop helper",
        "--set-version-string",
        "CompanyName",
        "MusicDownloader",
        "--set-version-string",
        "LegalCopyright",
        "Source: github.com/cristonj/MusicDownloader",
        "--set-file-version",
        process.env.HELPER_VERSION || "1.0.0",
        "--set-product-version",
        process.env.HELPER_VERSION || "1.0.0",
      ],
      { stdio: "inherit" },
    );
  } catch (error) {
    console.warn(`Could not stamp the Windows icon: ${error.message}`);
  }
const { size } = await stat(`helper-dist/${filename}`);
console.log(
  `Created helper-dist/${filename} (${(size / 1024 / 1024).toFixed(1)} MB)`,
);
