# MusicDownloader

A personal music downloader. Paste a song or playlist link, choose a format, download.

## Run or deploy

```sh
npm ci
npm run dev
```

Open http://localhost:3000. **No API keys, resolver URLs, Python installation, or separate service.** The app automatically prepares its private extraction tool before development/build. Node 22+ is required by the application.

For Netlify, connect the repository and deploy. `netlify.toml` builds the complete Next.js application; Netlify's Next.js adapter runs the API routes on demand. There are no required environment variables or additional services to configure. Alternatively, `docker compose up --build` runs the whole app on http://localhost:8080.

## Downloads

- YouTube songs/playlists, SoundCloud tracks/sets, and public Bandcamp tracks/albums use the built-in server endpoints.
- Spotify public songs, albums, and playlists import metadata without an API key, then match to YouTube recordings. Review the visible matches and select the recordings to download. Unmatched entries stay visible; private/unavailable tracks are not silently replaced.
- Local files stay on the device. Direct audio URLs also work when their server permits browser access.
- Original, MP3, AAC/M4A, FLAC, WAV, OGG/Vorbis, Opus, and AIFF. Lossy bitrate, lossless bit depth, and sample rate where supported. Increasing output settings cannot recover detail missing from the source.
- Select several tracks for a ZIP. Conversion and ZIP creation use browser workers. No accounts, database, analytics, or uploaded local files.

## How the server works

`/api/resolve` reads a public track list. Spotify matches use bounded parallel `/api/match` requests. `/api/audio` opens a selected source only when requested; `/api/media` transfers signed, allowlisted CDN audio in chunks of at most 2 MiB. This keeps every response below Netlify's [function payload limits](https://docs.netlify.com/build/functions/configuration/). No audio files or jobs are persisted on the server.

Progressive audio is passed through. Unencrypted on-demand HLS audio is assembled in the browser and remuxed without re-encoding for Original exports. Source access still happens on the web server when necessary; conversion and playlist ZIPs stay on the device. FFmpeg WebAssembly (~31 MB) loads only when conversion/remuxing is needed.

The build downloads a pinned standalone yt-dlp release, verifies its SHA-256 against the release checksum list, and generates a private signing key. Both live in ignored `.server/` and are included in the server's deployment trace, never in `public/` or the browser bundle. A fresh deployment automatically supplies its own signing key. Linux x64/arm64, macOS, and Windows x64 development hosts are supported by the preparation script.

Each server invocation has a bounded timeout. Public source URLs and CDN hosts are allowlisted; generic yt-dlp extraction is disabled. Media tickets expire after one hour, cross-origin requests are rejected, transfers are bounded, and local inputs never go to these endpoints. Serverless in-memory rate limits are a small additional guard, not an authentication system.

Availability, region restrictions, anti-bot checks, and upstream metadata/extractor changes can still prevent individual downloads. Encrypted/live streams and private or paid-only files require your originals. Spotify metadata embeds may be unavailable or incomplete; use a smaller public playlist when the source does not expose the full list. There is no claim to download or decrypt Spotify streams.

Browser limits: 100 tracks, 150 MB per input, 450 MB retained collection. Phones may need smaller lossless batches. Tracks disappear on refresh; only audio preferences persist. Use music you own or have permission to download.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm start
npm run test:e2e
```

Browser tests require Chromium (`npx playwright install chromium` or `PLAYWRIGHT_CHROMIUM_PATH`) and `ffprobe`. They inspect real exported codecs, ZIP bytes, source matching, failures, preferences, and mobile layout. External music services are mocked in automated tests; conversion uses real FFmpeg WASM. See [third-party notices](THIRD_PARTY_NOTICES.md).
