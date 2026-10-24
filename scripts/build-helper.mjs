import { build } from "esbuild";
import { mkdir, writeFile, cp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
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
  ],
  { stdio: "inherit", env: process.env },
);
console.log(`Created helper-dist/${filename}`);
