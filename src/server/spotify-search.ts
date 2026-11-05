import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isArtworkUrl } from "@/lib/model";
import { HttpError } from "./security";
// Spotify's search page is public, but only a browser can run it. An installed
// Edge or Chrome opens the page signed out, in a throwaway profile, and the rows
// it shows are read back. A hosted server has no browser, so this needs the helper.
function browserPath() {
  const installed =
    process.platform === "win32"
      ? [
          process.env["ProgramFiles(x86)"],
          process.env.ProgramFiles,
          process.env.LOCALAPPDATA,
        ].flatMap((root) =>
          root
            ? [
                join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
                join(root, "Google", "Chrome", "Application", "chrome.exe"),
              ]
            : [],
        )
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : [
            "/usr/bin/google-chrome",
            "/usr/bin/microsoft-edge",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
          ];
  return installed.find((path) => existsSync(path));
}
export interface SearchRow {
  title?: string;
  artists?: string;
  time?: string;
  art?: string;
}
const seconds = (time = "") => {
  const parts = time.split(":").map(Number);
  return parts.length >= 2 && parts.every(Number.isFinite)
    ? parts.reduce((total, part) => total * 60 + part, 0)
    : undefined;
};
// Spotify lists one recording once per release; the first is its most relevant.
export function searchTracks(rows: SearchRow[], limit: number) {
  const seen = new Set<string>();
  const tracks = [];
  for (const row of rows) {
    const title = row.title?.trim();
    if (!title) continue;
    const artist = row.artists?.trim() || "";
    const key = `${title}\n${artist}`.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Rows show a 64px cover; the same image is published at 300px.
    const artwork = row.art?.replace("ab67616d00004851", "ab67616d00001e02");
    tracks.push({
      title: title.slice(0, 300),
      artist: artist.slice(0, 200),
      duration: seconds(row.time),
      artwork: artwork && isArtworkUrl(artwork) ? artwork : undefined,
    });
    if (tracks.length >= limit) break;
  }
  return tracks;
}
// Rows render as the list scrolls, so each read brings the next ones into view.
const READ_ROWS = `(() => {
  const rows = [...document.querySelectorAll('[data-testid="tracklist-row"]')];
  rows.at(-1)?.scrollIntoView({ block: "end" });
  return JSON.stringify({
    rows: rows.map((row) => {
      const track = row.querySelector('a[href*="/track/"]');
      return {
        id: track?.getAttribute("href"),
        title: track?.textContent,
        artists: [...row.querySelectorAll('a[href*="/artist/"]')]
          .map((artist) => artist.textContent)
          .join(", "),
        art: row.querySelector("img")?.src,
        time: [...row.querySelectorAll("div")]
          .map((cell) => cell.textContent)
          .find((text) => /^\\d+:\\d\\d(?::\\d\\d)?$/.test(text || "")),
      };
    }),
    page: rows.length ? "" : document.body?.innerText.slice(0, 1000) || "",
  });
})()`;
const PAGE_TIMEOUT = 15000;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function debuggerPort(profile: string, deadline: number) {
  while (Date.now() < deadline) {
    const port = await readFile(join(profile, "DevToolsActivePort"), "utf8")
      .then((text) => Number(text.split("\n")[0]))
      .catch(() => 0);
    if (port) return port;
    await wait(100);
  }
  throw new Error("The browser did not start.");
}
const COMMAND_TIMEOUT = 8000;
type Commands = {
  send: (method: string, params?: object) => Promise<Record<string, any>>;
  close: () => void;
};
// Every command settles: a browser that stops answering or closes must fail the
// search, since a pending command would hold up every search queued behind it.
export function commandChannel(
  socket: Pick<WebSocket, "send" | "close" | "onmessage" | "onclose">,
  timeout = COMMAND_TIMEOUT,
): Commands {
  const pending = new Map<
    number,
    {
      done: (value: Record<string, any>) => void;
      fail: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let next = 0,
    closed = false;
  const settle = (id: number) => {
    const command = pending.get(id);
    if (command) clearTimeout(command.timer);
    pending.delete(id);
    return command;
  };
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id) settle(message.id)?.done(message.result || {});
  };
  socket.onclose = () => {
    closed = true;
    for (const id of [...pending.keys()])
      settle(id)?.fail(new Error("The browser closed."));
  };
  return {
    send: (method, params = {}) =>
      new Promise((done, fail) => {
        if (closed) return fail(new Error("The browser closed."));
        const id = ++next;
        const timer = setTimeout(() => {
          settle(id)?.fail(new Error("The browser stopped responding."));
        }, timeout);
        pending.set(id, { done, fail, timer });
        socket.send(JSON.stringify({ id, method, params }));
      }),
    close: () => socket.close(),
  };
}
function connect(url: string) {
  return new Promise<Commands>((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("The browser refused the page."));
    }, COMMAND_TIMEOUT);
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("The browser refused the page."));
    };
    socket.onopen = () => {
      clearTimeout(timer);
      resolve(commandChannel(socket));
    };
  });
}
async function readSearchPage(
  path: string,
  query: string,
  limit: number,
  signal?: AbortSignal,
) {
  const profile = await mkdtemp(join(tmpdir(), "musicdownloader-browser-"));
  const browser = spawn(
    path,
    [
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-sync",
      "--window-size=1400,1000",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  // A browser that cannot start reports it through the port wait below.
  browser.on("error", () => {});
  const stop = () => browser.kill();
  if (signal?.aborted) stop();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const deadline = Date.now() + PAGE_TIMEOUT;
    const port = await debuggerPort(profile, deadline);
    const targets = await (
      await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(5000),
      })
    ).json();
    const target = targets.find(
      (item: { type: string }) => item.type === "page",
    );
    const page = await connect(target.webSocketDebuggerUrl);
    try {
      await page.send("Page.navigate", {
        url: `https://open.spotify.com/search/${encodeURIComponent(query)}/tracks`,
      });
      const found = new Map<string, SearchRow>();
      let idle = 0,
        text = "";
      while (Date.now() < deadline && !signal?.aborted) {
        await wait(250);
        const { result } = await page.send("Runtime.evaluate", {
          expression: READ_ROWS,
          returnByValue: true,
        });
        const read = JSON.parse(result?.value || '{"rows":[]}');
        const before = found.size;
        for (const row of read.rows) if (row.id) found.set(row.id, row);
        text = read.page;
        idle = found.size > before ? 0 : idle + 1;
        if (found.size >= limit * 2 || (found.size && idle >= 8)) break;
        if (/no results found/i.test(text)) break;
      }
      return { rows: [...found.values()], text };
    } finally {
      page.close();
    }
  } finally {
    signal?.removeEventListener("abort", stop);
    browser.kill();
    // Windows holds the profile briefly after exit; results need not wait.
    void rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 250,
    }).catch(() => {});
  }
}
// Searches run side by side; the cap only stops a burst opening many browsers.
const MAX_BROWSERS = 3;
let open = 0;
const waiting: (() => void)[] = [];
async function withBrowserSlot<T>(run: () => Promise<T>): Promise<T> {
  while (open >= MAX_BROWSERS)
    await new Promise<void>((resolve) => waiting.push(resolve));
  open++;
  try {
    return await run();
  } finally {
    open--;
    waiting.shift()?.();
  }
}
export async function spotifySearch(
  query: string,
  limit: number,
  signal?: AbortSignal,
) {
  const path = browserPath();
  if (!path)
    throw new HttpError(
      422,
      "Spotify search runs in Edge or Chrome on your computer. Open the desktop helper, or install one of those browsers, and search again.",
    );
  const reading = withBrowserSlot(async () => {
    if (signal?.aborted) throw new Error("Cancelled");
    // The budget also ends a read whose browser never answers.
    const budget = AbortSignal.timeout(PAGE_TIMEOUT + 3000);
    return readSearchPage(
      path,
      query,
      limit,
      signal ? AbortSignal.any([signal, budget]) : budget,
    );
  });
  const { rows, text } = await reading.catch(() => {
    if (signal?.aborted) throw new HttpError(499, "Search cancelled.");
    throw new HttpError(502, "Spotify's search page could not be opened.");
  });
  if (signal?.aborted) throw new HttpError(499, "Search cancelled.");
  if (rows.length) return searchTracks(rows, limit);
  if (/no results found/i.test(text)) return [];
  // A challenge is left for the listener. It is never answered or worked around.
  if (/captcha|are you human|unusual|just a moment|verify/i.test(text))
    throw new HttpError(
      429,
      "Spotify asked for a human check, so search stopped. Try again later, or paste a Spotify link.",
    );
  throw new HttpError(
    502,
    "Spotify's search page showed no tracks. Its layout may have changed.",
  );
}
