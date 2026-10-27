import { feedFor, FEED_PROVIDERS } from "@/server/feed";
import {
  errorResponse,
  guardRequest,
  HttpError,
  privateHeaders,
  readBody,
} from "@/server/security";
import type { Provider } from "@/lib/model";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    guardRequest(request, 120);
    const data = await readBody(request);
    if (
      typeof data.provider !== "string" ||
      !FEED_PROVIDERS.includes(data.provider as Provider)
    )
      throw new HttpError(400, "Choose a service with a public feed.");
    if (data.query !== undefined && typeof data.query !== "string")
      throw new HttpError(400, "Use text to search.");
    const query = (data.query || "").replace(/\s+/g, " ").trim().slice(0, 120);
    return Response.json(
      await feedFor(data.provider as Provider, query, request.signal),
      { headers: privateHeaders },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
