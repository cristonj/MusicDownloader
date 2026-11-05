import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHelper, installState } from "../helper/install";
describe("self-install", () => {
  let root = "";
  afterEach(() => rm(root, { recursive: true, force: true }));
  it("is per-user, adds a shortcut and uninstall entry, and replaces older copies", async () => {
    root = await mkdtemp(join(tmpdir(), "music-install-"));
    const executable = join(root, "download.exe");
    await writeFile(executable, "first");
    const paths = {
      executable,
      localAppData: join(root, "local"),
      appData: join(root, "roaming"),
    };
    expect(installState(paths)).toEqual({
      available: true,
      installed: false,
      current: false,
    });
    const calls: string[][] = [];
    const run = (_: string, args: string[]) => calls.push(args);
    expect(await installHelper(paths, "1.0.9", run)).toMatchObject({
      installed: true,
    });
    const target = join(
      paths.localAppData,
      "Programs",
      "MusicDownloader Helper",
      "MusicDownloader-Helper.exe",
    );
    expect(await readFile(target, "utf8")).toBe("first");
    // Never writes outside the current user's registry hive.
    expect(calls.every((args) => args[1].startsWith("HKCU\\"))).toBe(true);
    expect(calls.find((args) => args[3] === "UninstallString")?.[5]).toBe(
      `"${target}" --uninstall`,
    );
    const shortcut = join(
      paths.appData,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "MusicDownloader Helper.url",
    );
    expect(existsSync(shortcut)).toBe(true);
    await writeFile(executable, "second");
    await installHelper(paths, "1.0.10", run);
    expect(await readFile(target, "utf8")).toBe("second");
    // Running the installed copy itself has nothing to replace.
    expect(
      await installHelper({ ...paths, executable: target }, "1.0.10", run),
    ).toMatchObject({ current: true });
    expect(await readFile(target, "utf8")).toBe("second");
  });
  it("is not offered outside the packaged Windows helper", () => {
    expect(installState(undefined).available).toBe(false);
  });
});
