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
export type Accounts = Partial<Record<"youtube" | "soundcloud", Browser>>;
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
      !browsers.includes(browser as Browser)
    )
      throw new Error("Choose a supported service and browser.");
    next[provider as keyof Accounts] = browser as Browser;
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
  return browser ? ["--cookies-from-browser", browser, "--no-cache-dir"] : [];
}
