import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
// The built page and its assets, so the app runs with no hosted server. Only
// known file types inside the app's own folder are ever returned.
export async function appFile(root: string, pathname: string) {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const base = resolve(root);
  const file = resolve(base, path === "/" ? "index.html" : `.${path}`);
  const type = TYPES[extname(file).toLowerCase()];
  if (!type || !file.startsWith(base + sep)) return null;
  try {
    return {
      body: await readFile(file),
      type,
      immutable: path.startsWith("/_next/static/"),
    };
  } catch {
    return null;
  }
}
