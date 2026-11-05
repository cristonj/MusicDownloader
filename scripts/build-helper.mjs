import { build } from "esbuild";
import { mkdir, writeFile, cp, rm, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { writeIcon } from "./make-icon.mjs";
import { need } from "@yao-pkg/pkg-fetch";
import { resolve } from "node:path";
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
// The helper serves the built page itself, so nothing depends on a hosted server.
execFileSync(process.execPath, ["scripts/copy-ffmpeg.mjs"], {
  stdio: "inherit",
});
execFileSync(
  process.execPath,
  ["node_modules/next/dist/bin/next", "build", "--webpack"],
  { stdio: "inherit", env: process.env },
);
await rm(".helper-build/assets/app", { recursive: true, force: true });
await cp("public", ".helper-build/assets/app", { recursive: true });
await cp(".next/static", ".helper-build/assets/app/_next/static", {
  recursive: true,
});
await cp(".next/server/app/index.html", ".helper-build/assets/app/index.html");
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
  define: {
    "process.env.HELPER_VERSION": JSON.stringify(
      process.env.HELPER_VERSION || "1.0.0",
    ),
  },
});
const filename = `MusicDownloader-Helper-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
const pkgEnv = { ...process.env };
if (platform === "win32" && process.platform === "win32") {
  // Editing resources after pkg appends its payload moves the embedded files
  // without updating pkg's offsets. Stamp an isolated base runtime instead.
  const runtime = await need({ nodeRange: "node22", platform: "win", arch });
  const stampedRuntime = resolve(".helper-build/node-stamped.exe");
  await cp(runtime, stampedRuntime);
  const icon = await writeIcon(".helper-build/app.ico");
  execFileSync("node_modules/rcedit/bin/rcedit-x64.exe", [
    stampedRuntime,
    "--set-icon", icon,
    "--set-version-string", "ProductName", "MusicDownloader Helper",
    "--set-version-string", "FileDescription", "MusicDownloader desktop helper",
    "--set-version-string", "CompanyName", "MusicDownloader",
    "--set-version-string", "LegalCopyright", "Source: github.com/cristonj/MusicDownloader",
    "--set-file-version", process.env.HELPER_VERSION || "1.0.0",
    "--set-product-version", process.env.HELPER_VERSION || "1.0.0",
  ], { stdio: "inherit" });
  pkgEnv.PKG_NODE_PATH = stampedRuntime;
}
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
  { stdio: "inherit", env: pkgEnv },
);
if (platform === process.platform && arch === process.arch)
  execFileSync(resolve(`helper-dist/${filename}`), ["--self-test"], {
    stdio: "inherit",
    timeout: 120000,
  });
const { size } = await stat(`helper-dist/${filename}`);
console.log(
  `Created helper-dist/${filename} (${(size / 1024 / 1024).toFixed(1)} MB)`,
);
