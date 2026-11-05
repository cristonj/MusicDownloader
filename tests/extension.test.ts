import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync, writeFileSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import { chromium, type BrowserContext } from "@playwright/test";
import { ExtensionBridge, cookieJar, prepareExtension } from "../helper/extension";
import { accountArgs, enableLocalAccounts, localAccounts, saveLocalAccounts } from "../helper/accounts";
import { startHelper } from "../helper/server";
vi.mock("../src/server/extractor", () => ({
  extract: vi.fn(), clearExtractions: vi.fn(), extractUsingClient: vi.fn(),
  rememberExtraction: vi.fn(), invalidateExtraction: vi.fn(),
}));
const root = process.cwd();
const home = mkdtempSync(join(tmpdir(), "music-bridge-test-"));
const appOrigin = "https://musicdownloaderapp.netlify.app";
const extOrigin = `chrome-extension://${"a".repeat(32)}`;
const appToken = "app-token-for-test";
let bridge: ExtensionBridge, server: Server, port: number, base: string;
const cookie = { domain: ".youtube.com", path: "/", name: "SID", value: "fixture-session", secure: true, httpOnly: true };
const call = (path: string, origin: string, token?: string, body?: unknown) => fetch(base + path, {
  method: body === undefined ? "GET" : "POST",
  headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
beforeAll(async () => {
  process.chdir(home); enableLocalAccounts();
  bridge = new ExtensionBridge(home);
  server = await startHelper({ token: appToken, origin: appOrigin, port: 0,
    state: () => ({ ready: true }),
    extension: { bridge, directory: join(home, "browser-extension"), open: () => false },
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  process.chdir(root); rmSync(home, { recursive: true, force: true });
});

describe("extension sessions", () => {
  it("rejects cross-service domains, cookie-file injection, and oversized arrays", () => {
    expect(cookieJar("youtube", [cookie])).toContain("#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tfixture-session");
    expect(() => cookieJar("soundcloud", [cookie])).toThrow();
    expect(() => cookieJar("youtube", [{ ...cookie, value: "injected\nline" }])).toThrow();
    expect(() => cookieJar("youtube", [{ ...cookie, domain: ".youtube.com.attacker.test" }])).toThrow();
    expect(() => cookieJar("youtube", Array(501).fill(cookie))).toThrow();
    expect(cookieJar("youtube", [{ ...cookie, partitionKey: { topLevelSite: "https://example.com" } }])).not.toContain("SID");
    expect(cookieJar("youtube", [{ ...cookie, expirationDate: 1 }])).not.toContain("SID");
  });
  it("requires an authenticated app to begin pairing and a one-use code for the extension", async () => {
    expect((await call("/extension/setup", appOrigin, undefined, { browser: "chrome" })).status).toBe(401);
    expect((await call("/extension/setup", extOrigin, undefined, { browser: "chrome" })).status).toBe(403);
    expect((await call("/extension/pair", "https://attacker.test", undefined, { code: "x" })).status).toBe(403);
    const setup = await (await call("/extension/setup", appOrigin, appToken, { browser: "chrome" })).json();
    expect(setup.code).toMatch(new RegExp(`^${port}\\.`));
    const code = setup.code.split(".")[1];
    expect((await call("/extension/pair", extOrigin, undefined, { code: "wrong" })).status).toBe(400);
    const response = await call("/extension/pair", extOrigin, undefined, { code });
    expect(response.headers.get("access-control-allow-origin")).toBe(extOrigin);
    const { token } = await response.json();
    expect((await call("/extension/pair", extOrigin, undefined, { code })).status).toBe(400);
    expect((await call("/health", extOrigin, token)).status).toBe(403);
    expect((await call("/health", appOrigin, token)).status).toBe(401);
    expect((await call("/extension/session", `chrome-extension://${"b".repeat(32)}`, token, { service: "youtube", cookies: [cookie], enable: true })).status).toBe(401);
    expect((await call("/extension/session", extOrigin, token, { service: "youtube", cookies: [cookie], enable: true })).status).toBe(200);
    const args = accountArgs("ytsearch1:a song");
    expect(args[0]).toBe("--cookies");
    expect(readFileSync(args[1], "utf8")).toContain("fixture-session");
    expect(accountArgs("https://soundcloud.com/artist/song")).toEqual([]);
    const status = await (await call("/extension/status", appOrigin, appToken)).json();
    expect(JSON.stringify(status)).not.toContain("fixture-session");
    expect(status.services.youtube).toBeTruthy();
    expect(bridge.sync("youtube", [], false).cookieCount).toBe(0);
    expect(readFileSync(args[1], "utf8")).not.toContain("fixture-session");
    saveLocalAccounts({}); bridge.status();
    expect(existsSync(args[1])).toBe(false);
    bridge.sync("youtube", [cookie], false);
    expect(localAccounts()).toEqual({});
    bridge.sync("youtube", [cookie], true);
    const currentFile = accountArgs("ytsearch1:a song")[1];
    bridge.revoke();
    expect(existsSync(currentFile)).toBe(false);
    expect(bridge.authorized(extOrigin, token)).toBe(false);
  });
  it("expires pairing codes and session files and persists only the scoped connection", () => {
    const code = bridge.pairing(port).code.split(".")[1];
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301_000);
    expect(() => bridge.pair(extOrigin, code)).toThrow("expired"); clock.mockRestore();
    const nextCode = bridge.pairing(port).code.split(".")[1];
    const { token } = bridge.pair(extOrigin, nextCode);
    bridge.sync("youtube", [cookie], true);
    const file = accountArgs("ytsearch1:a song")[1];
    expect(readFileSync(join(home, "extension-pair.json"), "utf8")).not.toContain("fixture-session");
    const expired = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 901_000);
    expect(() => accountArgs("ytsearch1:a song")).toThrow("Sync sessions");
    bridge.status(); expect(existsSync(file)).toBe(false); expired.mockRestore();
    bridge.close();
    bridge = new ExtensionBridge(home);
    // Server's bridge remains the original object; this test exercises restart
    // persistence independently. Subsequent browser test gets its own server.
    expect(bridge.authorized(extOrigin, token)).toBe(true);
    expect(bridge.status().services).toEqual({});
    bridge.revoke(); bridge.close();
  });
  it("ships only the declared extension files", async () => {
    const target = await prepareExtension(resolve(root, "browser-extension"), home);
    expect(readdirSync(target).sort()).toEqual(["background.js", "manifest.json", "popup.css", "popup.html", "popup.js"]);
    const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"]);
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
  });
});

it("pairs a real Chromium extension and transfers only enabled service sessions over loopback", async () => {
  // Browser permissions are pregranted in this disposable test-only manifest.
  // The production extension requests them from an explicit Connect click.
  const folder = join(home, "extension-test"); cpSync(resolve(root, "browser-extension"), folder, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
  manifest.host_permissions.push(...manifest.optional_host_permissions);
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest));
  let browserBridge = new ExtensionBridge(home);
  let local = await startHelper({ token: appToken, origin: appOrigin, port: 0, state: () => ({ ready: true }),
    extension: { bridge: browserBridge, directory: folder, open: () => false },
  });
  let context: BrowserContext | undefined;
  try {
    const address = local.address();
    const localPort = typeof address === "object" && address ? address.port : 0;
    context = await chromium.launchPersistentContext(join(home, "profile"), {
      channel: "chromium", headless: true,
      args: [`--disable-extensions-except=${folder}`, `--load-extension=${folder}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).hostname;
    await context.addCookies([{ name: "SID", value: "browser-fixture-session", domain: ".youtube.com", path: "/", secure: true, httpOnly: true }]);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/popup.html`);
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("button")?.disabled);
    await page.locator("#code").fill(browserBridge.pairing(localPort).code);
    await page.getByRole("button", { name: "Pair with helper", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#status")?.textContent?.startsWith("Paired."));
    await page.getByRole("button", { name: "Connect YouTube Music", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#status")?.textContent?.startsWith("Session synced."));
    const file = accountArgs("https://music.youtube.com/watch?v=abcdefghijk")[1];
    expect(readFileSync(file, "utf8")).toContain("browser-fixture-session");
    expect(browserBridge.status().services.youtube).toBeTruthy();
    expect(browserBridge.status().services.soundcloud).toBeUndefined();
    await new Promise<void>((done) => local.close(() => done()));
    expect(existsSync(file)).toBe(false);
    browserBridge = new ExtensionBridge(home);
    local = await startHelper({ token: appToken, origin: appOrigin, port: localPort, state: () => ({ ready: true }),
      extension: { bridge: browserBridge, directory: folder, open: () => false },
    });
    await page.getByRole("button", { name: "Sync sessions", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#status")?.textContent === "Sessions synced with the helper.");
    const refreshedFile = accountArgs("ytsearch1:a song")[1];
    expect(readFileSync(refreshedFile, "utf8")).toContain("browser-fixture-session");
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#status")?.textContent?.startsWith("Disconnected."));
    expect(existsSync(refreshedFile)).toBe(false);
    expect(localAccounts()).toEqual({});
  } finally {
    await context?.close();
    await new Promise<void>((done) => local.close(() => done()));
  }
}, 60_000);
