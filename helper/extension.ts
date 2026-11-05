import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cp, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { extensionSession, forgetExtensionSession, forgetExtensionSessions, localAccounts, saveLocalAccounts, type Service } from "./accounts";

export const extensionOrigin = (value: string) => /^chrome-extension:\/\/[a-p]{32}$/.test(value);
const equal = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export function cookieJar(service: Service, input: unknown, now = Date.now()) {
  if (!Array.isArray(input) || input.length > 500) throw new Error("Invalid session cookies.");
  const domain = service === "youtube" ? "youtube.com" : "soundcloud.com";
  const lines = input.map((cookie) => {
    if (!cookie || typeof cookie !== "object") throw new Error("Invalid cookie.");
    const { name, value, path, domain: host, expirationDate } = cookie;
    if (typeof host !== "string" || !/^\.?[a-z0-9.-]+$/.test(host) ||
        !(host.replace(/^\./, "") === domain || host.endsWith(`.${domain}`)) ||
        typeof name !== "string" || !name || /[\x00-\x20\x7f;=]/.test(name) ||
        typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value) ||
        typeof path !== "string" || !path.startsWith("/") || /[\x00-\x20\x7f]/.test(path) ||
        (expirationDate !== undefined && (!Number.isFinite(expirationDate) || expirationDate < 0)))
      throw new Error("Cookie is outside the enabled service or has invalid fields.");
    if (cookie.partitionKey) return ""; // Netscape jars cannot represent partitions.
    if (expirationDate && expirationDate * 1000 <= now) return "";
    return [cookie.httpOnly ? `#HttpOnly_${host}` : host,
      host.startsWith(".") ? "TRUE" : "FALSE", path,
      cookie.secure ? "TRUE" : "FALSE", Math.floor(expirationDate || 0), name, value].join("\t");
  }).filter(Boolean);
  return "# Netscape HTTP Cookie File\n" + lines.join("\n") + "\n";
}

// Extension credentials are separate from the app token and authorize only
// these bridge operations. Session material lives in a per-run temporary jar.
export class ExtensionBridge {
  private credential?: { origin: string; token: string };
  private code?: { value: string; expires: number };
  private temporary: string;
  private sessions = new Map<Service, { expires: number; updated: number }>();
  private config: string;
  constructor(home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.config = join(home, "extension-pair.json");
    this.temporary = mkdtempSync(join(tmpdir(), "music-extension-"));
    try {
      const saved = JSON.parse(readFileSync(this.config, "utf8"));
      if (extensionOrigin(saved.origin) && /^[A-Za-z0-9_-]{43}$/.test(saved.token)) this.credential = saved;
    } catch { /* Not paired yet. */ }
  }
  pairing(port: number) {
    this.code = { value: randomBytes(24).toString("base64url"), expires: Date.now() + 300_000 };
    return { code: `${port}.${this.code.value}`, expires: this.code.expires };
  }
  pair(origin: string, code: unknown) {
    if (!extensionOrigin(origin) || typeof code !== "string" || !this.code ||
        this.code.expires <= Date.now() || !equal(code, this.code.value))
      throw new Error("Pairing code is invalid or expired. Generate a new code in the app.");
    this.code = undefined;
    this.clearSessions();
    this.credential = { origin, token: randomBytes(32).toString("base64url") };
    writeFileSync(this.config, JSON.stringify(this.credential), { mode: 0o600 });
    return { token: this.credential.token };
  }
  authorized(origin: string, token: string) {
    return Boolean(this.credential && origin === this.credential.origin && equal(token, this.credential.token));
  }
  sync(service: unknown, cookies: unknown, enable: unknown) {
    if (service !== "youtube" && service !== "soundcloud") throw new Error("Choose a supported service.");
    if (typeof enable !== "boolean") throw new Error("Invalid session request.");
    const accounts = localAccounts();
    // Automatic refresh must never undo a disconnect or browser selection in the app.
    if (!enable && accounts[service] !== "extension") return { active: false };
    const jar = cookieJar(service, cookies);
    const file = join(this.temporary, `${service}.txt`);
    writeFileSync(file, jar, { mode: 0o600 });
    const expires = Date.now() + 900_000;
    this.sessions.set(service, { expires, updated: Date.now() });
    extensionSession(service, file, expires);
    if (enable) saveLocalAccounts({ ...accounts, [service]: "extension" });
    return { active: true, expires, cookieCount: jar.split("\n").filter((line) => line && !line.startsWith("# Netscape")).length };
  }
  status() {
    const services: Partial<Record<Service, { updated: number; expires: number }>> = {};
    for (const [service, state] of this.sessions) {
      if (state.expires <= Date.now() || localAccounts()[service] !== "extension") {
        try { unlinkSync(join(this.temporary, `${service}.txt`)); } catch {}
        this.sessions.delete(service);
        forgetExtensionSession(service);
      } else if (localAccounts()[service] === "extension") services[service] = state;
    }
    return { paired: Boolean(this.credential), services };
  }
  private clearSessions() {
    this.sessions.clear();
    forgetExtensionSessions();
    for (const service of ["youtube", "soundcloud"])
      try { unlinkSync(join(this.temporary, `${service}.txt`)); } catch {}
  }
  revoke() {
    this.code = undefined;
    this.credential = undefined;
    try { unlinkSync(this.config); } catch {}
    this.clearSessions();
    const accounts = localAccounts();
    for (const service of ["youtube", "soundcloud"] as const)
      if (accounts[service] === "extension") delete accounts[service];
    saveLocalAccounts(accounts);
  }
  close() {
    this.clearSessions();
    rmSync(this.temporary, { recursive: true, force: true });
  }
}

export async function prepareExtension(source: string, home: string) {
  const directory = join(home, "browser-extension");
  await mkdir(directory, { recursive: true });
  for (const name of ["manifest.json", "background.js", "popup.html", "popup.js", "popup.css"])
    await cp(join(source, name), join(directory, name));
  return directory;
}

export function openExtensionSetup(browser: "chrome" | "edge", directory: string) {
  if (process.platform !== "win32") return false;
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean) as string[];
  const binary = roots.map((root) => join(root, ...(browser === "edge"
    ? ["Microsoft", "Edge", "Application", "msedge.exe"]
    : ["Google", "Chrome", "Application", "chrome.exe"]))).find(existsSync);
  if (!binary) throw new Error(`Install ${browser === "edge" ? "Edge" : "Chrome"} first, or choose the other browser.`);
  spawn(binary, [browser === "edge" ? "edge://extensions/" : "chrome://extensions/"],
    { stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  spawn("explorer.exe", [directory], { stdio: "ignore", windowsHide: true }).on("error", () => {}).unref();
  return true;
}
