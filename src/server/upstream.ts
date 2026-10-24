import { fetch as proxyFetch, EnvHttpProxyAgent } from "undici";
import { allowedMedia, HttpError } from "./security";
const dispatcher =
  process.env.HTTPS_PROXY || process.env.HTTP_PROXY
    ? new EnvHttpProxyAgent()
    : undefined;
export async function publicFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  return (await proxyFetch(url, {
    ...init,
    dispatcher,
    redirect: "manual",
  } as Parameters<typeof proxyFetch>[1])) as unknown as Response;
}
export async function mediaFetch(
  value: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  let url = allowedMedia(value).href;
  for (let i = 0; i < 4; i++) {
    const response = await publicFetch(url, {
      headers,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = allowedMedia(
        new URL(response.headers.get("location") || "", url).href,
      ).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(
        response.status === 403 || response.status === 410 ? 410 : 502,
        "The source link is unavailable or expired. Import it again.",
      );
    }
    return response;
  }
  throw new HttpError(502, "The source redirected too many times.");
}
