import { mkdir, copyFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const core = dirname(require.resolve("@ffmpeg/core"));
await mkdir("public/ffmpeg", { recursive: true });
for (const file of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
  await copyFile(join(core, file), join("public/ffmpeg", file));
}
