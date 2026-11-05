import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { POST as resolve } from "../src/app/api/resolve/route";
import { POST as match } from "../src/app/api/match/route";
import { POST as feed } from "../src/app/api/feed/route";
import { POST as sources } from "../src/app/api/sources/route";
import { POST as lookup } from "../src/app/api/lookup/route";
import { GET as audio } from "../src/app/api/audio/route";
import { GET as media } from "../src/app/api/media/route";

import { localAccounts, saveLocalAccounts } from "./accounts";
import { appFile } from "./app-files";
import { clearExtractions, extract } from "../src/server/extractor";
import { extensionOrigin, type ExtensionBridge } from "./extension";
export const HELPER_PORT = 45821;
export function startHelper(options: {
  token: string;
  origin: string;
  port?: number;
  state: () => { ready: boolean; error?: string };
  onQuit?: () => void;
  // The built app, served from this computer in place of the hosted page.
  appDir?: string;
  install?: { state: () => unknown; run: () => Promise<unknown> };
  extension?: { bridge: ExtensionBridge; directory: string; open: (browser: "chrome" | "edge") => boolean | Promise<boolean> };
}) {
  const port = options.port ?? HELPER_PORT;
  const routes: Record<string, (request: Request) => Promise<Response>> = {
    "POST /api/resolve": resolve,
    "POST /api/match": match,
    "POST /api/feed": feed,
    "POST /api/sources": sources,
    "POST /api/lookup": lookup,
    "GET /api/audio": audio,
    "GET /api/media": media,
  };
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const address = server.address();
      const actualPort =
        typeof address === "object" && address ? address.port : port;
      const local = `http://127.0.0.1:${actualPort}`;
      const path = new URL(req.url || "/", local).pathname;
      const origin = req.headers.origin ||
        (typeof req.headers["x-musicdownloader-extension"] === "string"
          ? `chrome-extension://${req.headers["x-musicdownloader-extension"]}` : "");
      const fromExtension = extensionOrigin(origin) &&
        /^\/extension\/(?:pair|session|status|disconnect)$/.test(path);
      const cors = {
        "Access-Control-Allow-Origin":
          fromExtension ? origin : req.headers.origin === local ? local : options.origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Range, X-MusicDownloader-Extension",
        "Access-Control-Expose-Headers":
          "Content-Range, Content-Length, X-Audio-More",
        "Access-Control-Allow-Private-Network": "true",
        Vary: "Origin",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      };
      const respond = (status: number, body: unknown) => {
        res.writeHead(status, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (
        options.appDir &&
        req.headers.host === `127.0.0.1:${actualPort}` &&
        (req.method === "GET" || req.method === "HEAD") &&
        !/^\/(?:api\/|health$|accounts(?:\/|$)|extension(?:\/|$)|install$|quit$)/.test(path)
      ) {
        const file = await appFile(options.appDir, path);
        res.writeHead(file ? 200 : 404, {
          "Content-Type": file?.type || "text/plain",
          "Cache-Control": file?.immutable
            ? "public, max-age=31536000, immutable"
            : "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY",
          "Cross-Origin-Resource-Policy": "same-origin",
        });
        res.end(req.method === "HEAD" ? undefined : file?.body);
        return;
      }
      if (req.headers.host === `127.0.0.1:${actualPort}` && fromExtension) {
        const bridge = options.extension?.bridge;
        if (!bridge) { respond(404, { detail: "Update the helper for extension support." }); return; }
        if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
        if (path !== "/extension/pair" && !bridge.authorized(origin,
          req.headers.authorization?.replace(/^Bearer /, "") || "")) {
          respond(401, { detail: "Pair this extension from the MusicDownloader app." }); return;
        }
        try {
          if (path === "/extension/status" && req.method === "GET") {
            respond(200, bridge.status()); return;
          }
          if (req.method !== "POST") { respond(405, { detail: "Use POST." }); return; }
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (Buffer.byteLength(body) > 512_000) throw new Error("Session request too large.");
          }
          const value = JSON.parse(body || "{}");
          if (path === "/extension/pair") respond(200, bridge.pair(origin, value.code));
          else if (path === "/extension/session") {
            const result = bridge.sync(value.service, value.cookies, value.enable);
            clearExtractions();
            respond(200, result);
          } else if (path === "/extension/disconnect") {
            bridge.revoke(); clearExtractions(); respond(200, { ok: true });
          } else respond(404, { detail: "Unknown extension endpoint." });
        } catch (error) {
          respond(400, { detail: error instanceof Error ? error.message : "Extension request failed." });
        }
        return;
      }
      // Browsers send no Origin on a same-origin GET from the local app.
      const trusted =
        req.headers.origin === options.origin ||
        req.headers.origin === local ||
        (!req.headers.origin &&
          req.headers["sec-fetch-site"] === "same-origin");
      if (req.headers.host !== `127.0.0.1:${actualPort}` || !trusted) {
        respond(403, {
          detail:
            "This helper only accepts connections from your MusicDownloader app.",
        });
        return;
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      const received = Buffer.from(
        req.headers.authorization?.replace(/^Bearer /, "") || "",
      );
      const expected = Buffer.from(options.token);
      if (
        received.length !== expected.length ||
        !timingSafeEqual(received, expected)
      ) {
        respond(401, { detail: "Open the helper again to reconnect." });
        return;
      }
      const url = new URL(req.url || "/", options.origin);
      if (url.pathname === "/health") {
        respond(200, {
          app: "MusicDownloader",
          version: 11,
          ...options.state(),
        });
        return;
      }
      if (path === "/extension/status" && req.method === "GET") {
        respond(200, options.extension?.bridge.status() || { available: false, paired: false, services: {} });
        return;
      }
      if (path === "/extension/setup" && req.method === "POST") {
        try {
          if (!options.extension) throw new Error("Update and reopen the desktop helper for extension setup.");
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 128) throw new Error("Invalid setup request.");
          }
          const { browser } = JSON.parse(body);
          if (browser !== "chrome" && browser !== "edge") throw new Error("Choose Chrome or Edge.");
          const opened = await options.extension.open(browser);
          respond(200, { ...options.extension.bridge.pairing(actualPort), directory: options.extension.directory, opened });
        } catch (error) {
          respond(400, { detail: error instanceof Error ? error.message : "Could not open extension setup." });
        }
        return;
      }
      if (path === "/extension/disconnect" && req.method === "POST") {
        options.extension?.bridge.revoke(); clearExtractions(); respond(200, { ok: true }); return;
      }
      if (url.pathname === "/accounts" && req.method === "GET") {
        respond(200, { accounts: localAccounts() });
        return;
      }
      if (url.pathname === "/accounts" && req.method === "POST") {
        try {
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 2048) throw new Error("Request too large.");
          }
          const accounts = saveLocalAccounts(JSON.parse(body));
          options.extension?.bridge.status();
          clearExtractions();
          respond(200, { accounts });
        } catch {
          respond(400, {
            detail:
              "Could not save account settings. Choose a supported browser.",
          });
        }
        return;
      }
      if (url.pathname === "/accounts/check" && req.method === "POST") {
        try {
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 256) throw new Error("Request too large.");
          }
          const { service } = JSON.parse(body);
          // Reading anything proves the browser's session can be opened. Only
          // listed watch history proves a sign-in: signed out, it returns empty.
          const found = await extract(
            service === "youtube"
              ? "https://www.youtube.com/feed/history"
              : "scsearch1:music",
            true,
          );
          respond(200, {
            signedIn: service === "youtube" && Boolean(found.entries?.length),
          });
        } catch (error) {
          respond(422, {
            detail:
              error instanceof Error
                ? error.message
                : "This browser could not be read.",
          });
        }
        return;
      }
      if (url.pathname === "/install" && req.method === "GET") {
        respond(200, options.install?.state() ?? { available: false });
        return;
      }
      if (url.pathname === "/install" && req.method === "POST") {
        try {
          if (!options.install) throw new Error("Unavailable.");
          respond(200, await options.install.run());
        } catch {
          respond(500, {
            detail: "Could not install the helper on this computer.",
          });
        }
        return;
      }
      if (url.pathname === "/quit" && req.method === "POST") {
        respond(200, { ok: true });
        server.close(() => options.onQuit?.());
        return;
      }
      if (!options.state().ready) {
        respond(503, {
          detail:
            options.state().error ||
            "Your helper is getting ready. Please wait.",
        });
        return;
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) {
        respond(404, { detail: "Unknown helper endpoint." });
        return;
      }
      const controller = new AbortController();
      req.on("aborted", () => controller.abort());
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 8192) {
            respond(413, { detail: "Request too large." });
            return;
          }
          chunks.push(chunk);
        }
        const headers = new Headers();
        for (const name of ["content-type", "range"]) {
          const value = req.headers[name];
          if (typeof value === "string") headers.set(name, value);
        }
        headers.set("origin", options.origin);
        const request = new Request(url, {
          method: req.method,
          headers,
          signal: controller.signal,
          ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
        });
        const response = await route(request);
        const outgoing: Record<string, string> = { ...cors };
        response.headers.forEach((value, key) => (outgoing[key] = value));
        res.writeHead(response.status, outgoing);
        const bytes = Buffer.from(await response.arrayBuffer());
        res.end(bytes);
      } catch (error) {
        if (!res.headersSent)
          respond(500, {
            detail:
              error instanceof Error
                ? error.message
                : "The helper could not open this track.",
          });
        else res.end();
      }
    },
  );
  const expiry = setInterval(() => options.extension?.bridge.status(), 60_000);
  expiry.unref();
  server.on("close", () => { clearInterval(expiry); options.extension?.bridge.close(); });
  return new Promise<typeof server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
