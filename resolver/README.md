# Resolver

The browser converts audio and builds ZIPs. This companion reads service links and fetches source audio where CORS or service restrictions prevent a direct browser fetch. No accounts or database.

## Local

Requires Python 3.12+, Node 22+ (YouTube extraction), and FFmpeg.

```sh
python -m venv .venv
.venv/bin/pip install -r requirements.txt
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000 \
  .venv/bin/uvicorn app:app --host 127.0.0.1 --port 8080 --no-access-log
```

Set `NEXT_PUBLIC_RESOLVER_URL=http://localhost:8080` before starting the Next.js dev server, or enter it in Preferences. The root Docker image includes both the UI and this service; `docker compose up --build` needs no app-side configuration.

## Hosted

Deploy the root Dockerfile to a container host/VPS. It listens on `PORT` (default 8080), runs as a non-root user, and serves the UI too. Use HTTPS in front of it. Configure:

| Variable           | Value                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `ALLOWED_ORIGINS`  | Comma-separated exact frontend origins, e.g. `https://your-name.netlify.app`                                     |
| `RESOLVER_SECRET`  | Optional persistent random signing key. Otherwise generated on process start, invalidating old links on restart. |
| `STATIC_DIRECTORY` | Set by Docker; optional directory for serving the exported UI.                                                   |

For Netlify, set `NEXT_PUBLIC_RESOLVER_URL` on its build to this service's HTTPS origin. Service credentials, personal cookies, and Spotify accounts are not required. Spotify metadata uses SpotipyFree's anonymous public-metadata adapter. No Spotify audio is accessed. Playlist matching ranks up to five YouTube results per song using title, artist, duration, and version markers; ambiguous or unavailable tracks remain visible as errors.

The service allows only known music-service URL hosts, signs one-hour media URLs, caps each input at 150 MB, isolates extraction in timed subprocesses, limits concurrent source work to three, rate-limits requests, checks browser origins, and deletes temporary files after delivery or failure. The source is downloaded in original quality without server transcoding, then converted in the browser. For large public deployments, add authentication and infrastructure-level rate limits; this is intended as a personal service. Do not expose it as an unrestricted public download proxy.

Source audio temporarily passes through the resolver; local imports never do. Host it yourself or use a resolver you trust. Keep access logs disabled because media URLs carry short-lived bearer tokens.

## API

- `GET /health` → `{ "status": "ok" }`
- `POST /resolve` with `{ "url": "https://…" }` → `{ "title", "tracks": [{ "title", "artist", "duration", "extension", "sourceUrl", "mediaUrl" }] }`
- Spotify matches add `matchedTitle` and `matchConfidence`; unavailable entries have `error` instead of `mediaUrl`.
- `GET /media/{signed-token}` returns original audio bytes, `Content-Disposition`, and `X-Audio-Extension`. This ensures Original exports keep the real container extension.

Source timeouts, region/private content, anti-bot checks, and upstream site changes can still prevent downloads. The resolver never attempts to remove DRM, bypass paywalls, or access private accounts. Update yt-dlp and the metadata adapter when upstream sites change.
