import { mkdir, readFile, writeFile, chmod, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { fetch, EnvHttpProxyAgent } from "undici";

// A packaged Node executable cannot boot under yt-dlp's permission sandbox:
// pkg reads its own payload before Node has initialized filesystem grants.
// Ship the official standalone runtime for challenge solving instead.
export const JS_RUNTIME_VERSION = "v22.23.4";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function prepareJavaScriptRuntime(directory, options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  if (!["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"].includes(`${platform}-${arch}`))
    throw new Error("Unsupported JavaScript runtime platform.");
  const name = platform === "win32" ? "js-node.exe" : "js-node";
  const destination = new URL(name, directory);
  await mkdir(directory, { recursive: true });
  const valid = (meta, bytes) => meta.version === JS_RUNTIME_VERSION &&
    meta.platform === platform && meta.arch === arch && digest(bytes) === meta.sha256;
  try {
    const meta = JSON.parse(await readFile(new URL("js-runtime.json", directory), "utf8"));
    if (valid(meta, await readFile(destination))) return fileURLToPath(destination);
  } catch { /* Install or replace the pinned runtime. */ }
  if (options.bundledDir) {
    const meta = JSON.parse(await readFile(new URL("js-runtime.json", options.bundledDir), "utf8"));
    const bytes = await readFile(new URL(name, options.bundledDir));
    if (!valid(meta, bytes)) throw new Error("The bundled JavaScript runtime is invalid. Download a fresh helper.");
    await writeFile(destination, bytes);
    await chmod(destination, 0o755);
    await writeFile(new URL("js-runtime.json", directory), JSON.stringify(meta));
    return fileURLToPath(destination);
  }
  const dispatcher = process.env.HTTPS_PROXY || process.env.HTTP_PROXY ? new EnvHttpProxyAgent() : undefined;
  const download = async (file) => {
    const response = await fetch(`https://nodejs.org/dist/${JS_RUNTIME_VERSION}/${file}`, {
      dispatcher, signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`Could not obtain the JavaScript runtime (${response.status}).`);
    return Buffer.from(await response.arrayBuffer());
  };
  try {
    const prefix = `node-${JS_RUNTIME_VERSION}-${platform === "darwin" ? "darwin" : "linux"}-${arch}`;
    const artifact = platform === "win32" ? `win-${arch}/node.exe` :
      `${prefix}.${platform === "darwin" ? "tar.gz" : "tar.xz"}`;
    const sums = (await download("SHASUMS256.txt")).toString("utf8");
    const expected = sums.split("\n").map((line) => line.trim().split(/\s+/))
      .find((parts) => parts[1] === artifact)?.[0];
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("JavaScript runtime checksum is missing.");
    const archive = await download(artifact);
    if (digest(archive) !== expected) throw new Error("JavaScript runtime checksum mismatch.");
    let bytes = archive;
    if (platform !== "win32") {
      const temporary = await mkdtemp(join(tmpdir(), "music-node-build-"));
      try {
        const file = join(temporary, "runtime.tar");
        await writeFile(file, archive);
        bytes = execFileSync("tar", [platform === "darwin" ? "-xzOf" : "-xJOf", file, `${prefix}/bin/node`],
          { maxBuffer: 160 * 1024 * 1024 });
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    await writeFile(destination, bytes);
    await chmod(destination, 0o755);
    await writeFile(new URL("js-runtime.json", directory), JSON.stringify({
      version: JS_RUNTIME_VERSION, platform, arch, sha256: digest(bytes),
    }));
    return fileURLToPath(destination);
  } finally { await dispatcher?.close(); }
}
