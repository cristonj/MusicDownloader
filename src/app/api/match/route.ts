import { matchTrack } from "@/server/catalog";
import {
  errorResponse,
  guardRequest,
  HttpError,
  privateHeaders,
  readBody,
  readTicket,
} from "@/server/security";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    guardRequest(request, 600);
    const data = await readBody(request);
    if (typeof data.ticket !== "string")
      throw new HttpError(400, "A track is required.");
    const { origin, ...track } = readTicket(data.ticket, "match");
    // Uploads the browser already failed to download.
    const exclude = Array.isArray(data.exclude)
      ? data.exclude
          .filter((url): url is string => typeof url === "string")
          .slice(0, 10)
      : [];
    return Response.json(
      await matchTrack(track, request.signal, origin, exclude),
      { headers: privateHeaders },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
