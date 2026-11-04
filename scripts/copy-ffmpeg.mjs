import { mkdir, copyFile, cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const core = dirname(require.resolve("@ffmpeg/core"));
await mkdir("public/ffmpeg", { recursive: true });
for (const file of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
  await copyFile(join(core, file), join("public/ffmpeg", file));
}

// Self-host the libopus ESM and its embedded WASM; no third-party runtime requests.
const opus = dirname(fileURLToPath(import.meta.resolve("libopus-wasm")));
await cp(opus, "public/opus", { recursive: true });
for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
  await copyFile(join(opus, "..", file), join("public/opus", file));
