# MusicDownloader

A personal music downloader. Paste a song or playlist link, choose a format, download.

## Desktop setup

Open the web app and choose **Desktop helper** (the download icon). The wizard provides a Windows `.exe`, a Mac app ZIP (Intel and Apple Silicon), or a Linux archive. Download, open, and approve the browser's local connection prompt. No Python, Node, terminal commands, API keys, or resolver configuration for the user.

The self-contained helper bundles Node and the verified standalone extraction tool. It opens the web app and pairs automatically with a short-lived, device-local authorization token. Keep it running while downloading; use **Quit helper** in the wizard to stop it. These builds are unsigned, so the operating system may require an explicit allow/open confirmation. New helper builds are published automatically at [Desktop helper releases](https://github.com/cristonj/MusicDownloader/releases/tag/helper-v1).

When connected, **all source requests**—YouTube/YouTube Music, SoundCloud, Bandcamp, Spotify/Apple Music/Amazon Music metadata, and their YouTube matching—run from the computer's network connection. Existing tracks imported through the hosted API are re-resolved locally before downloading. This removes dependence on Netlify's IP for those operations; it does not guarantee access to private, region-restricted, or otherwise unavailable tracks, or remove a provider block affecting the user's own connection.

Service audio transfers use the loopback helper when connected, avoiding CDN cross-origin and header restrictions. HLS/DASH assembly, audio conversion, and playlist ZIP creation stay in browser workers. Local files never go to the helper or web server. Spotify, Apple Music, and Amazon Music audio comes from the visible YouTube matches, not from decrypted streams of those services.

The helper listens only on `127.0.0.1`, validates the Host and exact web-app Origin, requires its random per-launch token, and uses signed, allowlisted source URLs. Pairing secrets travel in the browser fragment (not to Netlify), then move to origin-scoped local storage and are removed from the address bar. Other websites cannot use its local API. Modern browsers may require local network permission.

## Development and deployment

```sh
npm ci
npm run dev
```

Node 22+ is needed only for development/building, not to run a packaged helper. Netlify remains the web-app host; the hosted APIs are available when a helper is not connected. Run `npm run build:helper` to create the native self-contained executable under `helper-dist/`. GitHub Actions builds Windows, Linux, and both Mac architectures, checks the bundled runtimes with an empty PATH, and publishes the wizard's downloads.

Open http://localhost:3000. Source access without the helper depends on the hosted server being accepted by the provider. The production desktop helper pairs only with https://musicdownloaderapp.netlify.app.

For Netlify, connect the repository and deploy. `netlify.toml` builds the complete Next.js application; Netlify's Next.js adapter runs the API routes on demand. There are no required environment variables or additional services to configure. Alternatively, `docker compose up --build` runs the whole app on http://localhost:8080.

## Downloads

- YouTube songs/playlists, SoundCloud tracks/sets, and public Bandcamp tracks/albums use the connected desktop helper, or the hosted API when no helper is connected.
- Spotify public songs, albums, and playlists import metadata without an API key, then match to YouTube recordings. Each match names the YouTube upload and channel it came from and why it was chosen. Only official uploads (artist channel, "- Topic", VEVO) with the same length are auto-selected; fan uploads are labelled and left for review. Spotify's public view lists at most 100 tracks of a playlist, and the app says so when it applies. Unmatched entries stay visible; private/unavailable tracks are not silently replaced.
- Apple Music songs, albums, and public playlists import the same way. Songs and albums read the public iTunes catalogue (no API key); playlists read the public playlist page's schema.org track list and then name each song's artist and length from that catalogue. Albums import up to 200 tracks, which is the catalogue's own page size.
- Amazon Music songs and albums import by the ASIN in the link, which is looked up in the public MusicBrainz database. Amazon Music publishes no public track list of its own, so a release nobody has catalogued there cannot be imported, and the app says so. Amazon Music playlists stay behind its sign-in and are not supported; import their albums or songs instead.
- A feed of each service's own public chart, and one search across all of them, can be switched on in Preferences (off by default). YouTube, Spotify, and Apple Music publish a chart anyone can read; YouTube, Apple Music, and SoundCloud also publish a search. Spotify's search and everything from Amazon Music and Bandcamp need an account, so those columns say so rather than guessing. Adding a row imports that one track, matching it first when the row is only a name. Charts and searches are held in server memory for ten minutes.
- Local files stay on the device. Direct audio URLs also work when their server permits browser access.
- Original, MP3, AAC/M4A, FLAC, WAV, OGG/Vorbis, Opus, and AIFF. Lossy bitrate, lossless bit depth, and sample rate where supported. Increasing output settings cannot recover detail missing from the source.
- Select several tracks for a ZIP. Conversion and ZIP creation use browser workers. No accounts, database, analytics, or uploaded local files.

## How the server works

`/api/feed` reads a service's public chart or search for the optional feed. `/api/resolve` reads a public track list. Spotify, Apple Music, and Amazon Music matches use bounded parallel `/api/match` requests. `/api/audio` opens a selected source only when requested; `/api/media` transfers signed, allowlisted CDN audio in chunks of at most 2 MiB. This keeps every response below Netlify's [function payload limits](https://docs.netlify.com/build/functions/configuration/). No audio files or jobs are persisted on the server.

Progressive audio is passed through. Unencrypted on-demand HLS audio is assembled in the browser and remuxed without re-encoding for Original exports. Source access still happens on the web server when necessary; conversion and playlist ZIPs stay on the device. FFmpeg WebAssembly (~31 MB) loads only when conversion/remuxing is needed.

The build downloads a pinned standalone yt-dlp release, verifies its SHA-256 against the release checksum list, and generates a private signing key. Both live in ignored `.server/` and are included in the server's deployment trace, never in `public/` or the browser bundle. A fresh deployment automatically supplies its own signing key. Linux x64/arm64, macOS, and Windows x64 development hosts are supported by the preparation script.

Each server invocation has a bounded timeout. Public source URLs and CDN hosts are allowlisted; generic yt-dlp extraction is disabled. Media tickets expire after one hour, cross-origin requests are rejected, transfers are bounded, and local inputs never go to these endpoints. Serverless in-memory rate limits are a small additional guard, not an authentication system.

Availability, region restrictions, anti-bot checks, and upstream metadata/extractor changes can still prevent individual downloads. Encrypted/live streams and private or paid-only files require your originals. Spotify and Apple Music metadata may be unavailable or incomplete; use a smaller public playlist when the source does not expose the full list. There is no claim to download or decrypt Spotify, Apple Music, or Amazon Music streams.

There is no fixed per-file or collection byte limit. Transfers and ZIPs use Blob chunks instead of retaining the entire collection in JavaScript arrays. Conversion still needs working memory in FFmpeg WebAssembly; available device memory limits large conversions, and phones may need smaller lossless batches. ZIP archives use ZIP32 and must fit under its 4 GB format limit; larger collections can be downloaded individually. Tracks disappear on refresh; only audio preferences persist. Use music you own or have permission to download.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm start
npm run test:e2e
```

Browser tests require Chromium (`npx playwright install chromium` or `PLAYWRIGHT_CHROMIUM_PATH`) and `ffprobe`. They inspect real exported codecs, ZIP bytes, source matching, failures, preferences, and mobile layout. External music services are mocked in automated tests; conversion uses real FFmpeg WASM. See [third-party notices](THIRD_PARTY_NOTICES.md).
