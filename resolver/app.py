"""Personal music resolver. Run behind HTTPS; conversions stay in the browser."""

import asyncio
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import shutil
import sys
import tempfile
import time
from collections import defaultdict, deque
from pathlib import Path
from urllib.parse import urlparse, urljoin

import httpx

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask

app = FastAPI(title="MusicDownloader resolver", docs_url=None, redoc_url=None)
ORIGINS = [
    x.strip()
    for x in os.getenv(
        "ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
    ).split(",")
    if x.strip()
]
SECRET = os.getenv("RESOLVER_SECRET", "").encode() or secrets.token_bytes(32)
SLOTS = asyncio.Semaphore(3)
BUCKETS = defaultdict(deque)
WORKER = Path(__file__).with_name("worker.py")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
    expose_headers=["Content-Disposition", "X-Audio-Extension"],
)


class Source(BaseModel):
    url: str = Field(min_length=8, max_length=2048)


def allowed_url(value, spotify=True):
    try:
        url = urlparse(value)
        host = (url.hostname or "").lower()
        if (
            url.scheme != "https"
            or url.username
            or url.password
            or url.port not in (443, None)
        ):
            raise ValueError()
        if host in {
            "youtube.com",
            "www.youtube.com",
            "m.youtube.com",
            "music.youtube.com",
            "youtu.be",
            "soundcloud.com",
            "www.soundcloud.com",
            "m.soundcloud.com",
            "on.soundcloud.com",
            "bandcamp.com",
            "www.bandcamp.com",
        }:
            return value
        if host.endswith(".bandcamp.com") and re.fullmatch(
            r"[a-z0-9-]+\.bandcamp\.com", host
        ):
            return value
        if spotify and host in {"open.spotify.com", "spotify.link"}:
            return value
    except ValueError:
        pass
    raise HTTPException(
        400, "Use a YouTube, SoundCloud, Bandcamp, or open.spotify.com music link."
    )


def token_for(url):
    payload = (
        base64.urlsafe_b64encode(
            json.dumps({"url": url, "exp": int(time.time()) + 3600}).encode()
        )
        .decode()
        .rstrip("=")
    )
    signature = hmac.new(SECRET, payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{signature}"


def token_url(token):
    try:
        payload, signature = token.split(".")
        expected = hmac.new(SECRET, payload.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature):
            raise ValueError()
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        if data["exp"] < time.time():
            raise HTTPException(410, "Link expired. Import the source again.")
        return allowed_url(data["url"], spotify=False)
    except HTTPException:
        raise
    except (ValueError, TypeError, KeyError):
        raise HTTPException(403, "Invalid download link.") from None


@app.middleware("http")
async def protect(request: Request, call_next):
    origin = request.headers.get("origin")
    same_origin = f"{request.url.scheme}://{request.url.netloc}"
    if origin and origin not in ORIGINS and origin != same_origin:
        return JSONResponse({"detail": "Origin is not allowed."}, status_code=403)
    if request.method == "POST":
        size, chunks = 0, []
        async for chunk in request.stream():
            size += len(chunk)
            if size > 8192:
                return JSONResponse({"detail": "Request too large."}, status_code=413)
            chunks.append(chunk)
        request._body = b"".join(chunks)
    if (
        request.url.path.startswith(("/resolve", "/media/"))
        and request.method != "OPTIONS"
    ):
        now = time.monotonic()
        # Bounded storage; do not trust caller-supplied forwarded IP headers.
        if len(BUCKETS) > 2048:
            BUCKETS.clear()
        bucket = BUCKETS[request.client.host if request.client else "local"]
        while bucket and bucket[0] < now - 60:
            bucket.popleft()
        if len(bucket) >= 180:
            return JSONResponse(
                {"detail": "Too many requests. Try again in a minute."}, status_code=429
            )
        bucket.append(now)
    return await call_next(request)


async def run_worker(mode, url, directory=None):
    args = [sys.executable, str(WORKER), mode, url]
    if directory:
        args.append(directory)
    async with SLOTS:
        process = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
        try:
            stdout, _ = await asyncio.wait_for(
                process.communicate(), timeout=170 if mode == "resolve" else 240
            )
        except (TimeoutError, asyncio.CancelledError):
            process.kill()
            await process.wait()
            raise HTTPException(
                504, "The source timed out. Try a smaller playlist or another link."
            ) from None
    try:
        result = json.loads(stdout)
    except (ValueError, TypeError):
        raise HTTPException(502, "The resolver could not read the source.") from None
    if process.returncode or result.get("error"):
        raise HTTPException(422, result.get("error", "Source unavailable."))
    return result


@app.get("/health")
def health():
    return {"status": "ok", "spotify": "youtube-matching"}


@app.post("/resolve")
async def resolve(source: Source):
    url = allowed_url(source.url)
    # Spotify's mobile share links redirect to public metadata pages.
    if urlparse(url).hostname == "spotify.link":
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            try:
                for _ in range(4):
                    response = await client.get(url)
                    if response.status_code not in (301, 302, 303, 307, 308):
                        break
                    url = allowed_url(
                        urljoin(url, response.headers.get("location", ""))
                    )
                    if urlparse(url).hostname == "open.spotify.com":
                        break
            except httpx.HTTPError:
                raise HTTPException(
                    422,
                    "Could not open this share link. Use the full open.spotify.com link.",
                ) from None
        if urlparse(url).hostname != "open.spotify.com":
            raise HTTPException(
                422, "Use the full open.spotify.com track or playlist link."
            )
    result = await run_worker("resolve", url)
    for track in result.get("tracks", []):
        if track.get("error"):
            continue
        try:
            url = allowed_url(track["sourceUrl"], spotify=False)
            track["mediaUrl"] = f"/media/{token_for(url)}"
        except (HTTPException, KeyError):
            track["error"] = "This entry has no supported audio source."
    return result


@app.get("/media/{token}")
async def media(token: str):
    url = token_url(token)
    directory = tempfile.mkdtemp(prefix="music-downloader-")
    try:
        result = await run_worker("download", url, directory)
        path = Path(directory) / result["filename"]
        if path.parent != Path(directory) or not path.is_file():
            raise HTTPException(502, "Invalid audio output.")
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        return FileResponse(
            path,
            media_type=mime,
            filename=path.name,
            headers={
                "X-Audio-Extension": result["extension"],
                "Cache-Control": "no-store",
            },
            background=BackgroundTask(shutil.rmtree, directory, ignore_errors=True),
        )
    except BaseException:
        shutil.rmtree(directory, ignore_errors=True)
        raise


# Optional single-host deployment. API routes are registered before static files.
STATIC = Path(os.getenv("STATIC_DIRECTORY", ""))
if os.getenv("STATIC_DIRECTORY") and STATIC.is_dir():
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="frontend")
