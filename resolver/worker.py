"""Isolated source work. stdout is JSON; third-party logs stay on stderr."""

import contextlib
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import yt_dlp

MAX_TRACKS = 100
MAX_BYTES = 150 * 1024 * 1024


class QuietLogger:
    def debug(self, message):
        pass

    def warning(self, message):
        pass

    def error(self, message):
        pass


def options():
    return {
        "quiet": True,
        "no_warnings": True,
        "logger": QuietLogger(),
        "socket_timeout": 15,
        "retries": 2,
        "extractor_retries": 1,
        "playlistend": MAX_TRACKS + 1,
        "skip_download": True,
        "extract_flat": "in_playlist",
        "cachedir": False,
        "allowed_extractors": ["youtube.*", "soundcloud.*", "bandcamp.*"],
        "js_runtimes": {"node": {}},
    }


def words(text):
    return set(re.findall(r"[^\W_]+", text.casefold()))


def match_score(title, artist, duration, candidate):
    found = str(candidate.get("title") or "")
    target_words, found_words = words(title), words(found)
    title_score = len(target_words & found_words) / max(1, len(target_words))
    artist_words = words(artist)
    artist_score = len(
        artist_words
        & (
            found_words
            | words(candidate.get("channel") or candidate.get("uploader") or "")
        )
    ) / max(1, len(artist_words))
    found_duration = candidate.get("duration")
    duration_score = 0.5
    if duration and found_duration:
        delta = abs(duration - found_duration)
        duration_score = max(0, 1 - delta / max(10, duration * 0.12))
    score = 0.5 * title_score + 0.25 * artist_score + 0.25 * duration_score
    # Avoid substituting a cover, remix, live version, or altered playback speed.
    for version in [
        "live",
        "remix",
        "cover",
        "karaoke",
        "instrumental",
        "slowed",
        "sped",
        "acoustic",
    ]:
        if (version in found_words) != (version in target_words):
            score -= 0.3
    if title_score < 0.65:
        score -= 0.4
    return round(max(0, min(1, score)), 3)


def spotify_tracks(url):
    # Metadata only. This client never requests Spotify audio or account cookies.
    from SpotipyFree import Spotify

    client = Spotify(login=False)
    parts = [part for part in urlparse(url).path.split("/") if part]
    if parts and parts[0].startswith("intl-"):
        parts = parts[1:]
    if (
        len(parts) != 2
        or parts[0] not in ("track", "playlist", "album")
        or not re.fullmatch(r"[A-Za-z0-9]{22}", parts[1])
    ):
        raise ValueError("Use an open.spotify.com track, album, or playlist link.")
    kind, identity = parts
    if kind == "track":
        track = client.track(identity)
        return track.get("name", "Spotify track"), [track]
    if kind == "album":
        album = client.album(identity)
        tracks = client.album_tracks(identity).get("items", [])
        for track in tracks:
            if not track.get("artists"):
                track["artists"] = album.get("artists", [])
        return album.get("name", "Spotify album"), tracks
    playlist = client.playlist(identity)
    page = client.playlist_items(identity)
    return playlist.get("name", "Spotify playlist"), [
        item.get("track") for item in page.get("items", []) if item.get("track")
    ]


def match_spotify_track(track):
    title = track.get("name") or "Untitled"
    artist = ", ".join(a.get("name", "") for a in track.get("artists", []))
    duration = (track.get("duration_ms") or 0) / 1000
    base = {"title": title, "artist": artist, "duration": duration}
    try:
        with yt_dlp.YoutubeDL(options()) as ydl:
            result = ydl.extract_info(
                f"ytsearch5:{artist} {title} official audio", download=False
            )
        candidates = list((result or {}).get("entries") or [])
        candidates = [c for c in candidates if c and not c.get("is_live")]
        best = max(
            candidates,
            key=lambda c: match_score(title, artist, duration, c),
            default=None,
        )
        score = match_score(title, artist, duration, best) if best else 0
        if not best or score < 0.58:
            return {
                **base,
                "error": "No close audio match found. Add a source link for this track.",
            }
        video_id = best.get("id", "")
        if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            raise ValueError("Invalid search result")
        return {
            **base,
            "sourceUrl": f"https://www.youtube.com/watch?v={video_id}",
            "extension": "m4a",
            "matchedTitle": best.get("title"),
            "matchConfidence": score,
        }
    except Exception:
        return {**base, "error": "Audio matching failed. Try re-importing this track."}


def resolve(url):
    if urlparse(url).hostname == "open.spotify.com":
        title, tracks = spotify_tracks(url)
        if len(tracks) > MAX_TRACKS:
            raise ValueError(
                "This playlist has over 100 tracks. Import a smaller playlist."
            )
        with ThreadPoolExecutor(max_workers=4) as pool:
            matched = list(pool.map(match_spotify_track, tracks))
        return {"title": title, "tracks": matched}
    with yt_dlp.YoutubeDL(options()) as ydl:
        result = ydl.extract_info(url, download=False)
    if not result:
        raise ValueError("No downloadable music found.")
    entries = list(result.get("entries") or [result])
    if len(entries) > MAX_TRACKS:
        raise ValueError(
            "This playlist has over 100 tracks. Import a smaller playlist."
        )
    tracks = []
    for entry in entries:
        if not entry:
            continue
        source = entry.get("webpage_url") or entry.get("url") or url
        if re.fullmatch(r"[A-Za-z0-9_-]{11}", source):
            source = f"https://www.youtube.com/watch?v={source}"
        item = {
            "title": entry.get("track") or entry.get("title") or "Untitled",
            "artist": entry.get("artist")
            or entry.get("uploader")
            or entry.get("channel")
            or "",
            "duration": entry.get("duration"),
            "extension": entry.get("ext") or "m4a",
            "sourceUrl": source,
        }
        if entry.get("is_live") or entry.get("availability") in (
            "private",
            "premium_only",
            "subscriber_only",
            "needs_auth",
        ):
            item["error"] = (
                "This track is live, private, or restricted. Import your original file."
            )
        tracks.append(item)
    if not tracks:
        raise ValueError("This source has no downloadable tracks.")
    return {"title": result.get("title", "Music"), "tracks": tracks}


def download(url, directory):
    def progress(data):
        if data.get("downloaded_bytes", 0) > MAX_BYTES:
            raise ValueError("Track exceeds 150 MB.")

    opts = options()
    opts.update(
        {
            "skip_download": False,
            "extract_flat": False,
            "noplaylist": True,
            "format": "bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best",
            "outtmpl": str(Path(directory) / "audio.%(ext)s"),
            "max_filesize": MAX_BYTES,
            "progress_hooks": [progress],
            "overwrites": True,
            "match_filter": yt_dlp.utils.match_filter_func("!is_live"),
        }
    )
    with yt_dlp.YoutubeDL(opts) as ydl:
        result = ydl.extract_info(url, download=True)
        path = Path(ydl.prepare_filename(result))
    if not path.is_file() or not 0 < path.stat().st_size <= MAX_BYTES:
        raise ValueError("Source is empty or exceeds 150 MB.")
    return {"filename": path.name, "extension": path.suffix[1:]}


if __name__ == "__main__":
    try:
        with contextlib.redirect_stdout(sys.stderr):
            result = (
                resolve(sys.argv[2])
                if sys.argv[1] == "resolve"
                else download(sys.argv[2], sys.argv[3])
            )
        print(json.dumps(result))
    except Exception as error:
        # Do not send upstream signed URLs, cookies, or exception dumps to the browser.
        print(
            json.dumps(
                {
                    "error": str(error)
                    if isinstance(error, ValueError)
                    else "The service could not open this link. It may be private, unavailable, or temporarily blocked."
                }
            )
        )
        sys.exit(1)
