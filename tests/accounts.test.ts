import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountArgs,
  enableLocalAccounts,
  saveLocalAccounts,
  validateAccounts,
  accountRevision,
} from "../helper/accounts";
const temporary = mkdtempSync(join(tmpdir(), "music-accounts-"));
const cwd = process.cwd();
afterAll(() => {
  process.chdir(cwd);
  rmSync(temporary, { recursive: true, force: true });
});
describe("explicit local account access", () => {
  it("does not read browser sessions on hosted servers or before opt-in", () =>
    expect(accountArgs("https://youtube.com/watch?v=abcdefghijk")).toEqual([]));
  it("accepts only fixed browser names, never paths or command arguments", () => {
    expect(() => validateAccounts({ youtube: "chrome --anything" })).toThrow();
    expect(() => validateAccounts({ spotify: "chrome" })).toThrow();
    expect(() => validateAccounts({ soundcloud: "/private/file" })).toThrow();
  });
  it("scopes browser sessions to the selected provider and stores no session data", () => {
    process.chdir(temporary);
    enableLocalAccounts();
    const previous = accountRevision();
    saveLocalAccounts({ youtube: "firefox" });
    expect(accountRevision()).toBeGreaterThan(previous);
    expect(accountArgs("ytsearch10:artist song")).toContain("firefox");
    expect(accountArgs("https://youtube.com/watch?v=abcdefghijk")).toEqual([
      "--cookies-from-browser",
      "firefox",
      "--no-cache-dir",
    ]);
    expect(accountArgs("https://soundcloud.com/artist/song")).toEqual([]);
    expect(accountArgs("https://artist.bandcamp.com/track/song")).toEqual([]);
    expect(readFileSync(join(temporary, "accounts.json"), "utf8")).toBe(
      '{"youtube":"firefox"}',
    );
    saveLocalAccounts({});
    expect(accountArgs("ytsearch10:artist song")).toEqual([]);
  });
});
