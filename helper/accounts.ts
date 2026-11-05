import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export const browsers = [
  "chrome",
  "edge",
  "firefox",
  "brave",
  "chromium",
  "safari",
] as const;
export type Browser = (typeof browsers)[number];
export type Service = "youtube" | "soundcloud";
export type Accounts = Partial<Record<Service, Browser | "extension">>;
const sessions = new Map<Service, { file: string; expires: number }>();
export function extensionSession(service: Service, file: string, expires: number) {
  sessions.set(service, { file, expires });
  revision++;
}
export function forgetExtensionSessions() {
  sessions.clear();
  revision++;
}
export function forgetExtensionSession(service: Service) {
  sessions.delete(service);
  revision++;
}
let enabled = false;
let revision = 0;
export const accountRevision = () => revision;
let accounts: Accounts = {};
export function enableLocalAccounts() {
  enabled = true;
  try {
    accounts = validateAccounts(
      JSON.parse(readFileSync(join(process.cwd(), "accounts.json"), "utf8")),
    );
  } catch {
    accounts = {};
  }
}
export function validateAccounts(value: unknown): Accounts {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid account settings.");
  const next: Accounts = {};
  for (const [provider, browser] of Object.entries(value)) {
    if (
      !["youtube", "soundcloud"].includes(provider) ||
      (browser !== "extension" && !browsers.includes(browser as Browser))
    )
      throw new Error("Choose a supported service and browser.");
    next[provider as keyof Accounts] = browser as Browser | "extension";
  }
  return next;
}
export function localAccounts() {
  return enabled ? { ...accounts } : {};
}
export function saveLocalAccounts(value: unknown) {
  if (!enabled)
    throw new Error("Account access is available only in the desktop helper.");
  const next = validateAccounts(value);
  writeFileSync(join(process.cwd(), "accounts.json"), JSON.stringify(next), {
    mode: 0o600,
  });
  accounts = next;
  revision++;
  return localAccounts();
}
export function accountArgs(url: string): string[] {
  if (!enabled) return [];
  const provider =
    /^ytsearch\d*:|^https:\/\/(?:www\.|music\.|m\.)?(?:youtube\.com|youtu\.be)\//.test(
      url,
    )
      ? "youtube"
      : /^scsearch\d*:|^https:\/\/(?:[\w-]+\.)?soundcloud\.com\//.test(url)
        ? "soundcloud"
        : undefined;
  const browser = provider && accounts[provider];
  if (browser === "extension" && provider) {
    const session = sessions.get(provider);
    if (!session || session.expires <= Date.now())
      throw new Error("Open the MusicDownloader browser extension and click Sync sessions to reconnect this account.");
    return ["--cookies", session.file, "--no-cache-dir"];
  }
  return browser ? ["--cookies-from-browser", browser, "--no-cache-dir"] : [];
}
