import { afterAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { prepareJavaScriptRuntime, JS_RUNTIME_VERSION } from "../scripts/js-runtime.mjs";
import { javascriptRuntime } from "../helper/js-runtime";
import { extractionFailure } from "../src/server/extraction-error";
const root = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), "music-js-runtime-test-"));
afterAll(() => { process.chdir(root); rmSync(temporary, { recursive: true, force: true }); });
it("verifies bundled runtime bytes before copying, and replaces a corrupted installed runtime", async () => {
  const source = join(temporary, "bundled"); mkdirSync(source);
  const filename = process.platform === "win32" ? "js-node.exe" : "js-node";
  const bytes = Buffer.from("runtime fixture");
  writeFileSync(join(source, filename), bytes);
  writeFileSync(join(source, "js-runtime.json"), JSON.stringify({ version: JS_RUNTIME_VERSION,
    platform: process.platform, arch: process.arch, sha256: createHash("sha256").update(bytes).digest("hex") }));
  const destination = pathToFileURL(join(temporary, "install") + sep);
  const options = { bundledDir: pathToFileURL(source + sep) };
  const file = await prepareJavaScriptRuntime(destination, options);
  expect(readFileSync(file)).toEqual(bytes);
  writeFileSync(file, "corrupted");
  await prepareJavaScriptRuntime(destination, options);
  expect(readFileSync(file)).toEqual(bytes);
  writeFileSync(join(source, filename), "tampered source");
  await expect(prepareJavaScriptRuntime(pathToFileURL(join(temporary, "other") + sep), options)).rejects.toThrow("invalid");
});
it("selects the dedicated challenge runtime instead of the packaged helper executable", () => {
  process.chdir(temporary);
  expect(javascriptRuntime()).toBe(process.execPath);
  mkdirSync(join(temporary, ".server"));
  const file = join(temporary, ".server", process.platform === "win32" ? "js-node.exe" : "js-node");
  writeFileSync(file, "fixture");
  expect(javascriptRuntime()).toBe(file);
  process.chdir(root);
});
it("boots the challenge runtime under Node permissions while denying unrelated file reads", () => {
  const result = execFileSync(javascriptRuntime(), ["--permission", "--input-type=module", "-"], {
    input: 'import fs from "node:fs";try {fs.readFileSync(process.execPath);process.exit(1);}catch(e){if(e.code!=="ERR_ACCESS_DENIED")throw e;}process.stdout.write("sandbox-ok");',
    encoding: "utf8", env: { ...process.env, PATH: "" },
  });
  expect(result).toBe("sandbox-ok");
});
it("does not retry a broken JavaScript sandbox as unavailable audio formats", () => {
  const failure = extractionFailure("Error: ERR_ACCESS_DENIED at node:internal/bootstrap/pkg\nERROR: Requested format is not available", true);
  expect(failure.category).toBe("JS_RUNTIME_SANDBOX");
  expect(failure.retryable).toBe(false);
});
