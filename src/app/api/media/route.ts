import { mediaChunk } from "@/server/media";
import {
  errorResponse,
  guardRequest,
  privateHeaders,
  readTicket,
} from "@/server/security";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    guardRequest(request);
    const ticket = readTicket(
      new URL(request.url).searchParams.get("ticket") || "",
      "media",
    );
    const result = await mediaChunk(
      ticket,
      request.headers.get("range"),
      request.signal,
    );
    return new Response(new Uint8Array(result.body), {
      status: 206,
      headers: {
        ...privateHeaders,
        "Content-Type": result.contentType,
        "Content-Range": `bytes ${result.start}-${result.end}/${result.total || "*"}`,
        "Content-Length": String(result.body.length),
        "Accept-Ranges": "bytes",
        "X-Audio-More": result.more ? "1" : "0",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
