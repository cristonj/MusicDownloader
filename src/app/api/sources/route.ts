import { sourceOptions } from "@/server/catalog";
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
    guardRequest(request, 120);
    const data = await readBody(request);
    if (typeof data.ticket !== "string")
      throw new HttpError(400, "A track is required.");
    const { origin, ...track } = readTicket(data.ticket, "match");
    return Response.json(
      { options: await sourceOptions(track, origin, request.signal) },
      { headers: privateHeaders },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
