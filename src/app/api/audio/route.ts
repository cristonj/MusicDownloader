import { audioManifest } from "@/server/media";
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
    guardRequest(request, 150);
    const ticket = readTicket(
      new URL(request.url).searchParams.get("ticket") || "",
      "source",
    );
    return Response.json(await audioManifest(ticket.url, request.signal), {
      headers: privateHeaders,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
