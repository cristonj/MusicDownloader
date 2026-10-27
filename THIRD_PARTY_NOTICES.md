# Third-party notices

MusicDownloader uses these third-party projects. Their own copyright and license terms apply:

- [FFmpeg](https://ffmpeg.org/legal.html) and [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm): the `@ffmpeg/core` build is GPL-2.0-or-later. It is served as a separate WebAssembly/JavaScript asset under `/ffmpeg/`; upstream source and build instructions for the pinned 0.12.10 core are at https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10. Preserve its license notices when distributing these assets and comply with the upstream source-distribution requirements.
- [fflate](https://github.com/101arrowz/fflate): MIT.
- [Lucide](https://lucide.dev/license): ISC.
- [DM Sans](https://github.com/googlefonts/dm-fonts) and [Manrope](https://github.com/sharanda/manrope): SIL Open Font License 1.1, bundled by Fontsource.
- [Next.js](https://github.com/vercel/next.js), [React](https://github.com/facebook/react): MIT.
- [yt-dlp](https://github.com/yt-dlp/yt-dlp): Unlicense, with separate third-party dependency licenses.
- [spotify-url-info](https://github.com/microlinkhq/spotify-url-info): MIT; reads public Spotify metadata.
- [Undici](https://github.com/nodejs/undici): MIT.

- [Node.js](https://github.com/nodejs/node/blob/main/LICENSE) is included in the desktop helper and retains its third-party terms. [@yao-pkg/pkg](https://github.com/yao-pkg/pkg) and [esbuild](https://github.com/evanw/esbuild) provide packaging (MIT). The helper embeds the standalone yt-dlp release; its bundled dependency terms also apply. Helper source and build scripts are included in this repository.

Public metadata services used without an API key:

- [iTunes Search API](https://performance-partners.apple.com/search-api): Apple's public catalogue, for Apple Music song, album, and playlist details.
- [MusicBrainz](https://musicbrainz.org/doc/MusicBrainz_API): community music database under its [licences](https://musicbrainz.org/doc/About/Data_License), for Amazon Music links by ASIN. Requests identify this app and retry when the service reports it is busy.

Service names and logos identify compatible link sources; MusicDownloader is not affiliated with those services.
