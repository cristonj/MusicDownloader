export const HELPER_PORT = 45821;
// Bump with helper/server.ts when the helper needs a fix the app relies on.
export const HELPER_VERSION = 3;
export const helperOutdated = (health: { version?: unknown }) =>
  typeof health.version !== "number" || health.version < HELPER_VERSION;
const KEY = "music-downloader:helper";
export class HelperRequiredError extends Error {}
interface Connection {
  token: string;
  port: number;
}
export function helperConnection(): Connection | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "null");
    return value &&
      /^[A-Za-z0-9_-]{43}$/.test(value.token) &&
      value.port === HELPER_PORT
      ? value
      : null;
  } catch {
    return null;
  }
}
export function consumeHelperPair(): boolean {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("helper_token"),
    port = Number(params.get("helper_port"));
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) || port !== HELPER_PORT)
    return false;
  localStorage.setItem(KEY, JSON.stringify({ token, port }));
  history.replaceState(null, "", location.pathname + location.search);
  window.dispatchEvent(new Event("music-helper-connected"));
  return true;
}
export function disconnectHelper() {
  localStorage.removeItem(KEY);
  window.dispatchEvent(new Event("music-helper-connected"));
}
export async function helperFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const connection = helperConnection();
  if (!connection)
    throw new HelperRequiredError("Open the desktop helper to connect.");
  if (
    !/^\/(?:api\/(?:resolve|match|lookup|audio|media)(?:\?|$)|health$|quit$)/.test(
      path,
    )
  )
    throw new Error("Invalid helper request.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${connection.token}`);
  try {
    const response = await fetch(`http://127.0.0.1:${connection.port}${path}`, {
      ...init,
      headers,
      credentials: "omit",
      targetAddressSpace: "loopback",
    } as RequestInit);
    if (response.status === 401)
      throw new HelperRequiredError("Open the helper again to reconnect.");
    return response;
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new HelperRequiredError(
      "Open the desktop helper and allow the browser connection.",
    );
  }
}
export function sourceFetch(
  path: string,
  init: RequestInit = {},
  transport?: "helper",
): Promise<Response> {
  return transport === "helper" ? helperFetch(path, init) : fetch(path, init);
}
// Every download is a GitHub release asset of this open-source repository.
export const HELPER_RELEASE =
  "https://github.com/cristonj/MusicDownloader/releases/tag/helper-v1";
export const HELPER_SOURCE = "https://github.com/cristonj/MusicDownloader";
export const helperDownloads = {
  windows:
    "https://github.com/cristonj/MusicDownloader/releases/download/helper-v1/MusicDownloader-Helper-Windows-Setup.exe",
  windowsPortable:
    "https://github.com/cristonj/MusicDownloader/releases/download/helper-v1/MusicDownloader-Helper-Windows.exe",
  mac: "https://github.com/cristonj/MusicDownloader/releases/download/helper-v1/MusicDownloader-Helper-Mac.zip",
  linux:
    "https://github.com/cristonj/MusicDownloader/releases/download/helper-v1/MusicDownloader-Helper-Linux.tar.gz",
};
