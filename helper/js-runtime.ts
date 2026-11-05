import { existsSync } from "node:fs";
import { join } from "node:path";
export function javascriptRuntime() {
  const dedicated = join(process.cwd(), ".server", process.platform === "win32" ? "js-node.exe" : "js-node");
  if (existsSync(dedicated)) return dedicated;
  if ((process as NodeJS.Process & { pkg?: unknown }).pkg)
    throw new Error("The helper's JavaScript runtime is missing. Reopen the updated helper to prepare it.");
  return process.execPath;
}
