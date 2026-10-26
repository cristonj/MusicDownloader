import { audioManifest } from "@/server/media";
import {
  errorResponse,
  guardRequest,
  HttpError,
  privateHeaders,
  readTicket,
} from "@/server/security";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  const deadline = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(52000),
  ]);
  try {
    guardRequest(request, 600);
    const ticket = readTicket(
      new URL(request.url).searchParams.get("ticket") || "",
      "source",
    );
    return Response.json(await audioManifest(ticket.url, deadline), {
      headers: privateHeaders,
    });
  } catch (error) {
    return errorResponse(
      deadline.aborted && !request.signal.aborted
        ? new HttpError(504, "The source took too long. Please try again.")
        : error,
    );
  }
}
