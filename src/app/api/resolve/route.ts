import { resolveCatalog } from "@/server/catalog";
import {
  errorResponse,
  guardRequest,
  HttpError,
  privateHeaders,
  readBody,
} from "@/server/security";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    guardRequest(request, 30);
    const data = await readBody(request);
    if (typeof data.url !== "string" || data.url.length > 2048)
      throw new HttpError(400, "Paste a music link.");
    return Response.json(await resolveCatalog(data.url, request.signal), {
      headers: privateHeaders,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
