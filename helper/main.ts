import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { prepareMediaTools } from "../scripts/media-tools.mjs";
import { prepareJavaScriptRuntime } from "../scripts/js-runtime.mjs";
import { startHelper, HELPER_PORT } from "./server";
import { enableLocalAccounts } from "./accounts";
import { ExtensionBridge, prepareExtension, openExtensionSetup } from "./extension";
import {
  installHelper,
  installPaths,
  installState,
  uninstallHelper,
} from "./install";
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
      const runtime = await prepareJavaScriptRuntime(pathToFileURL(join(temporary, ".server") + sep), {
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
        runtime,
        ["-e", "process.stdout.write(process.versions.node)"],
        { encoding: "utf8", env: { ...process.env, PATH: "" } },
      ).trim();
      if (!/^22\./.test(nodeVersion) || !/^2026\./.test(version))
        throw new Error("Bundled runtime check failed.");
      const sandbox = execFileSync(runtime, ["--permission", "--input-type=module", "-"], {
        encoding: "utf8", env: { ...process.env, PATH: "" },
        input: 'import fs from "node:fs"; try { fs.readFileSync(process.execPath); process.exit(1); } catch (e) { if (e.code !== "ERR_ACCESS_DENIED") throw e; } process.stdout.write("sandbox-ok");',
      });
      if (sandbox !== "sandbox-ok") throw new Error("The JavaScript challenge sandbox failed.");
      if (!existsSync(join(__dirname, "assets", "app", "index.html")))
        throw new Error("The bundled app is missing.");
      const extension = await prepareExtension(join(__dirname, "assets", "extension"), temporary);
      if (!existsSync(join(extension, "manifest.json"))) throw new Error("The bundled extension is missing.");
      console.log(
        "Bundled Node challenge sandbox, app, extension, and download tool work with an empty PATH.",
      );
    } finally {
      process.chdir(previous);
      await rm(temporary, { recursive: true, force: true });
    }
    return;
  }
  if (process.argv.includes("--uninstall")) {
    const paths = installPaths();
    if (paths) await uninstallHelper(paths);
    return;
  }
  const portFlag = process.argv.indexOf("--port");
  const port = portFlag > 0 ? Number(process.argv[portFlag + 1]) : HELPER_PORT;
  const appDir = join(__dirname, "assets", "app");
  const home = join(homedir(), ".musicdownloader");
  await mkdir(home, { recursive: true, mode: 0o700 });
  process.chdir(home);
  enableLocalAccounts();
  const extensionSource = join(__dirname, "assets", "extension");
  const extensionDir = existsSync(extensionSource)
    ? await prepareExtension(extensionSource, home) : undefined;
  const bridge = extensionDir ? new ExtensionBridge(home) : undefined;
  // Temporary session jars do not survive a clean helper shutdown.
  process.once("exit", () => bridge?.close());
  const token = randomBytes(32).toString("base64url");
  let state: { ready: boolean; error?: string } = { ready: false };
  try {
    await startHelper({
      token,
      origin: APP,
      port,
      state: () => state,
      onQuit: () => process.exit(0),
      appDir: existsSync(appDir) ? appDir : undefined,
      extension: bridge && extensionDir ? {
        bridge, directory: extensionDir,
        open: (browser) => openExtensionSetup(browser, extensionDir),
      } : undefined,
      install: {
        state: () => installState(),
        run: async () => {
          const paths = installPaths();
          if (!paths) throw new Error("Unavailable.");
          return installHelper(paths, process.env.HELPER_VERSION);
        },
      },
    });
  } catch (error) {
    console.error(
      "MusicDownloader helper is already open, or its local port is in use. Close the previous helper and reopen this one.",
    );
    process.exitCode = 1;
    return;
  }
  const pairing = `#helper_token=${token}&helper_port=${port}`;
  // The app comes from this computer. The hosted page remains an alternative.
  const paired = `${existsSync(appDir) ? `http://127.0.0.1:${port}/` : `${APP}/`}${pairing}`;
  const command =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", paired]]
      : process.platform === "darwin"
        ? ["open", [paired]]
        : ["xdg-open", [paired]];
  console.log(
    "MusicDownloader helper is running. Keep it open while downloading.",
  );
  console.log(`App: ${paired}`);
  try {
    if (!process.argv.includes("--no-open"))
      spawn(command[0] as string, command[1] as string[], {
        detached: true,
        stdio: "ignore",
      })
        .on("error", () =>
          console.log(
            `Open this address in your browser to connect:\n${paired}`,
          ),
        )
        .unref();
  } catch {
    console.log(`Open this address in your browser to connect:\n${paired}`);
  }
  try {
    await prepareJavaScriptRuntime(pathToFileURL(join(home, ".server") + sep), {
      bundledDir: pathToFileURL(join(__dirname, "assets") + sep),
    });
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
