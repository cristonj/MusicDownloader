# MusicDownloader

A small, personal music downloader. Paste a link, choose a format, keep a song or a playlist ZIP.

React, Next.js, TypeScript. No accounts, analytics, database, or uploaded local files.

## Run

```sh
npm ci
npm run dev
```

Open http://localhost:3000. Local files and direct audio URLs work immediately. Direct URLs must allow browser access (CORS).

For music-service links, run the [resolver](resolver/README.md) too. Or run the entire app and resolver together:

```sh
docker compose up --build
```

Open http://localhost:8080. The container automatically connects the interface to its resolver.

## What works

- **YouTube:** songs and playlists, through yt-dlp.
- **SoundCloud:** public tracks and sets, through yt-dlp.
- **Bandcamp:** publicly accessible tracks and albums, through yt-dlp. Import purchased originals for their full quality.
- **Spotify:** public track, album, and playlist metadata, matched to YouTube recordings. Matches are shown and start unselected for review. Unmatched tracks remain visible. It does not decrypt or download Spotify streams.
- **Local files / direct audio URLs:** no resolver required.
- **Exports:** Original, MP3, AAC/M4A, FLAC, WAV, OGG/Vorbis, Opus, AIFF. Bitrate, 16/24-bit lossless output, and sample-rate controls where applicable. Original avoids transcoding entirely.
- **ZIPs:** selected tracks, built locally in a worker; duplicate filenames are preserved.

Conversion uses same-origin FFmpeg WebAssembly, loaded only when needed (~31 MB). Network fetches run three at a time; conversions run serially to protect memory. ZIPs store already compressed audio without recompressing it. Cancellation, per-track errors, previews, selection, and saved preferences are included.

Higher export settings cannot recover information absent from the source. Source availability, source quality, rate limits, and region restrictions still apply. Public Spotify metadata and YouTube extraction can change upstream; matching is a best effort, not a guarantee of the same master.

Browser limits: 100 tracks, 150 MB per input, 450 MB retained collection. Large lossless conversions may need smaller batches, especially on phones. Tracks are held in memory and disappear on refresh; only preferences persist.

## Netlify

`netlify.toml` builds a static Next.js export with Node 22 and publishes `out/`. No Next.js server or paid serverless functions are needed for the interface.

1. Connect this repository in Netlify.
2. Host the Python resolver on a container host/VPS with HTTPS and outbound access to the four music services. It cannot run inside Netlify's static hosting.
3. Set **NEXT_PUBLIC_RESOLVER_URL** to its HTTPS URL in Netlify, then build/deploy.
4. Set **ALLOWED_ORIGINS** on the resolver to the exact Netlify site origin. See [resolver setup](resolver/README.md).

This configures service imports for him once, without asking him to set anything up in the app. Without that environment variable, a resolver can also be connected in Preferences. For a single-host deployment, the Docker image serves both parts.

## Check

```sh
npm run typecheck
npm test
npm run build
npm start                     # preview the static export on port 3000
npm run test:e2e
resolver/.venv/bin/python -m unittest resolver.test_resolver -v
```

Browser tests need Chromium (`npx playwright install chromium` or `PLAYWRIGHT_CHROMIUM_PATH`) and `ffprobe`. They validate actual audio codecs for every format, byte-preserving ZIPs, matching/review, errors, preferences, and phone layout. External services are mocked in automated tests; the local export path uses real FFmpeg WASM.

Use music you own or have permission to download. FFmpeg core is GPL licensed; see [third-party notices](THIRD_PARTY_NOTICES.md).
