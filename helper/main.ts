import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { prepareMediaTools } from "../scripts/media-tools.mjs";
import { startHelper, HELPER_PORT } from "./server";
const APP = "https://musicdownloaderapp.netlify.app";
async function main() {
  // pkg's embedded Node runtime doubles as yt-dlp's JavaScript engine. Users
  // install neither Node nor Python. This variable affects child runtimes only.
  if ((process as NodeJS.Process & { pkg?: unknown }).pkg)
    process.env.PKG_EXECPATH = "PKG_INVOKE_NODEJS";
  if (process.argv.includes("--runtime-check")) {
    console.log(
      execFileSync(
        process.execPath,
        ["-e", "process.stdout.write(process.versions.node)"],
        { encoding: "utf8" },
      ),
    );
    return;
  }
  if (process.argv.includes("--self-test")) {
    const temporary = await mkdtemp(join(tmpdir(), "music-helper-check-"));
    const previous = process.cwd();
    try {
      process.chdir(temporary);
      await prepareMediaTools(pathToFileURL(join(temporary, ".server") + sep), {
        bundledDir: pathToFileURL(join(__dirname, "assets") + sep),
      });
      const version = execFileSync(
        join(
          temporary,
          ".server",
          process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
        ),
        ["--version"],
        { encoding: "utf8", env: { ...process.env, PATH: "" } },
      ).trim();
      const nodeVersion = execFileSync(
        process.execPath,
        ["-e", "process.stdout.write(process.versions.node)"],
        { encoding: "utf8", env: { ...process.env, PATH: "" } },
      ).trim();
      if (!/^22\./.test(nodeVersion) || !/^2026\./.test(version))
        throw new Error("Bundled runtime check failed.");
      console.log("Bundled Node and download tool work with an empty PATH.");
    } finally {
      process.chdir(previous);
      await rm(temporary, { recursive: true, force: true });
    }
    return;
  }
  const home = join(homedir(), ".musicdownloader");
  await mkdir(home, { recursive: true, mode: 0o700 });
  process.chdir(home);
  const token = randomBytes(32).toString("base64url");
  let state: { ready: boolean; error?: string } = { ready: false };
  try {
    await startHelper({
      token,
      origin: APP,
      state: () => state,
      onQuit: () => process.exit(0),
    });
  } catch (error) {
    console.error(
      "MusicDownloader helper is already open, or its local port is in use. Close the previous helper and reopen this one.",
    );
    process.exitCode = 1;
    return;
  }
  const paired = `${APP}/#helper_token=${token}&helper_port=${HELPER_PORT}`;
  const command =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", paired]]
      : process.platform === "darwin"
        ? ["open", [paired]]
        : ["xdg-open", [paired]];
  console.log(
    "MusicDownloader helper is running. Keep it open while downloading.",
  );
  try {
    spawn(command[0] as string, command[1] as string[], {
      detached: true,
      stdio: "ignore",
    })
      .on("error", () =>
        console.log(`Open this address in your browser to connect:\n${paired}`),
      )
      .unref();
  } catch {
    console.log(`Open this address in your browser to connect:\n${paired}`);
  }
  try {
    await prepareMediaTools(pathToFileURL(join(home, ".server") + sep), {
      bundledDir: pathToFileURL(join(__dirname, "assets") + sep),
    });
    state = { ready: true };
    console.log("Ready. Downloads now use this computer’s connection.");
  } catch (error) {
    state = {
      ready: false,
      error:
        "The helper could not prepare its download tool. Check your connection and reopen it.",
    };
    console.error(state.error);
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Could not start MusicDownloader.",
  );
  process.exitCode = 1;
});
