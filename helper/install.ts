import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const APP_NAME = "MusicDownloader Helper";
const UNINSTALL_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MusicDownloaderHelper";
export interface InstallPaths {
  executable: string;
  localAppData: string;
  appData: string;
}
const installedExe = (paths: InstallPaths) =>
  join(paths.localAppData, "Programs", APP_NAME, "MusicDownloader-Helper.exe");
const shortcut = (paths: InstallPaths) =>
  join(
    paths.appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    `${APP_NAME}.url`,
  );
export function installPaths(): InstallPaths | undefined {
  const packaged = (process as NodeJS.Process & { pkg?: unknown }).pkg;
  const { LOCALAPPDATA: localAppData, APPDATA: appData } = process.env;
  return process.platform === "win32" && packaged && localAppData && appData
    ? { executable: process.execPath, localAppData, appData }
    : undefined;
}
export function installState(paths = installPaths()) {
  if (!paths) return { available: false, installed: false, current: false };
  const target = installedExe(paths);
  return {
    available: true,
    installed: existsSync(target),
    current: paths.executable.toLowerCase() === target.toLowerCase(),
  };
}
const registerValues = (paths: InstallPaths, version: string) => {
  const target = installedExe(paths);
  return {
    DisplayName: APP_NAME,
    DisplayIcon: target,
    DisplayVersion: version,
    Publisher: "MusicDownloader",
    InstallLocation: join(target, ".."),
    UninstallString: `"${target}" --uninstall`,
  };
};
// Installing is only ever asked for from the app. It is per-user, needs no
// administrator, and running a newer download then choosing it replaces the copy.
export async function installHelper(
  paths: InstallPaths,
  version = "1.0.0",
  run: (command: string, args: string[]) => unknown = (command, args) =>
    execFileSync(command, args, { stdio: "ignore", windowsHide: true }),
) {
  const target = installedExe(paths);
  await mkdir(join(target, ".."), { recursive: true });
  if (paths.executable.toLowerCase() !== target.toLowerCase())
    await copyFile(paths.executable, target);
  await mkdir(join(shortcut(paths), ".."), { recursive: true });
  await writeFile(
    shortcut(paths),
    `[InternetShortcut]\r\nURL=${pathToFileURL(target).href}\r\nIconFile=${target}\r\nIconIndex=0\r\n`,
  );
  for (const [name, value] of Object.entries(registerValues(paths, version)))
    run("reg", ["add", UNINSTALL_KEY, "/v", name, "/d", value, "/f"]);
  return installState(paths);
}
// Settings's Uninstall runs this. The running file cannot delete itself, so a
// short-lived shell removes the folder once it has exited.
export async function uninstallHelper(paths: InstallPaths) {
  await rm(shortcut(paths), { force: true });
  try {
    execFileSync("reg", ["delete", UNINSTALL_KEY, "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    /* Already removed. */
  }
  await rm(join(homedir(), ".musicdownloader"), {
    recursive: true,
    force: true,
  }).catch(() => {});
  spawn(
    "cmd.exe",
    [
      "/d",
      "/c",
      `ping -n 3 127.0.0.1 >nul & rmdir /s /q "${join(installedExe(paths), "..")}"`,
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  ).unref();
}
