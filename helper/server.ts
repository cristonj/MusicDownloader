import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { POST as resolve } from "../src/app/api/resolve/route";
import { POST as match } from "../src/app/api/match/route";
import { GET as audio } from "../src/app/api/audio/route";
import { readTicket } from "../src/server/security";
import { GET as media } from "../src/app/api/media/route";

export const HELPER_PORT = 45821;
export function startHelper(options: {
  token: string;
  origin: string;
  port?: number;
  state: () => { ready: boolean; error?: string };
  onQuit?: () => void;
}) {
  const port = options.port ?? HELPER_PORT;
  const routes: Record<string, (request: Request) => Promise<Response>> = {
    "POST /api/resolve": resolve,
    "POST /api/match": match,
    "GET /api/audio": audio,
    "GET /api/media": media,
  };
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const cors = {
        "Access-Control-Allow-Origin": options.origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
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
      const address = server.address();
      const actualPort =
        typeof address === "object" && address ? address.port : port;
      if (
        req.headers.host !== `127.0.0.1:${actualPort}` ||
        req.headers.origin !== options.origin
      ) {
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
          version: 2,
          ...options.state(),
        });
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
        if (url.pathname === "/api/audio" && response.ok) {
          const result = await response.json();
          if (result.parts?.length === 1) {
            const token = new URL(
              result.parts[0],
              options.origin,
            ).searchParams.get("ticket");
            if (token) {
              const stream = readTicket(token, "media");
              if (!stream.range) result.browserUrl = stream.url;
            }
          }
          res.end(JSON.stringify(result));
        } else {
          const bytes = Buffer.from(await response.arrayBuffer());
          res.end(bytes);
        }
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
  return new Promise<typeof server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
