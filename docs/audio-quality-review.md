# Audio quality improvement review

Prepared 4 November 2026. Scope: MusicDownloader's source selection, browser export pipeline, quality reporting, and optional desktop account access.

## Executive assessment

The default is now protected 24-bit FLAC at the source sample rate. This avoids another lossy encode, adds measured attenuation only when needed, and verifies output true peaks at or below -1 dBTP. FLAC files from lossy streams are larger without restoring lost detail. Original remains an explicit option for preserving the downloaded audio unchanged, including any decoded overs. Account access can improve the source available to eligible Google/YouTube Music and SoundCloud subscribers, while keeping session handling on the listener's computer.

The extractor uses `bestaudio[format_id!*=preview]/best[format_id!*=preview]`: best audio-only, falling back to a combined format when necessary, with preview formats excluded. Existing pre-version-3 Original defaults migrate to protected FLAC; later explicit Original choices persist. Other saved formats remain selected. Protected conversion refuses an unmeasurable source before integer quantization, so missing input peak data cannot silently lead to clipping.

“Maximum quality” means preserving the best accessible recording and avoiding unnecessary damage. It does not mean converting a lossy stream into a genuine studio master. A source's mastering, previous compression, entitlement, and availability remain outside the app's control.

## Changes and practical value

| Area | Previous behavior | New behavior and value |
| --- | --- | --- |
| Source selection | Direct HTTP audio could outrank a better segmented stream | Best available audio across delivery methods; preview-labelled formats excluded |
| HLS quality | First-attribute bandwidth values could be missed | Correct variant ranking prevents accidental lower-quality selection |
| Default export | Original/source rate, with 16-bit conversion defaults | Protected FLAC at source rate and 24-bit; Original remains selectable; maximum lossy settings retained |
| Bitrate controls | Compatible file extensions could trigger copying and ignore the selected bitrate | Explicit MP3/AAC/Opus exports encode to their requested target; Original is the preservation path |
| Opus encoding | Experimental native FFmpeg encoder used to avoid a WASM crash | Dedicated libopus 1.6.1 worker, complexity 10, music tuning, VBR; proper lookahead/end trimming |
| Other encoding | Fixed-rate Vorbis required stereo for some maximum settings | Quality-based Vorbis VBR preserves channel count; LAME uses its highest algorithm quality |
| Lossless conversion | Bit depth selectable | 24-bit default; triangular dither when quantization requires it; FLAC compression increased for storage efficiency, without changing fidelity |
| Quality visibility | No decoded loudness or peak measurements | On-device LUFS, loudness range, sample/true peak, duration and codec/rate reporting |
| Peak protection | No verification of output headroom | Enabled by default for conversions: attenuation-only processing, followed by actual output measurement and bounded correction |
| Replacements | An alternate upload could be obtained without updating the visible provenance | Replacement marker, actual source and match explanation retained |
| Account access | Anonymous extraction only | Explicit local browser-session access for Google/YouTube and SoundCloud, with an in-app walkthrough |

## Measured evidence

These are controlled regression fixtures, not measurements of arbitrary commercial tracks.

| Check | Result | Interpretation |
| --- | --- | --- |
| Intersample-peak stress fixture | +2.9 dBTP input; −1.2 dBTP protected WAV output | Protection reaches its ≤−1 dBTP target on the actual exported file |
| Browser meters versus native FFmpeg | Matching displayed input loudness and true-peak readings on the stress fixture | The browser reports the same rounded values as the independent native reference |
| Stereo Opus fidelity fixture, 320 kbps target | 41.34 dB and 43.96 dB signal-to-error ratio for left/right channels | Regression evidence against severe encoding or channel errors; not a perceptual transparency guarantee |
| Stereo Opus timing | Exact decoded sample count preserved | Encoder delay and terminal padding are handled correctly |
| Original HLS export | Canonically remuxed AAC packets match byte for byte | Audio survives the assembly/remux path without another lossy encode |
| Same-format MP3 | A 128 kbps input exports at the selected 320 kbps and 192 kbps rates | The output settings are honored; this does not recover lost source detail |
| Quiet float-to-24-bit conversion | Dither verified at the actual 24-bit quantization depth | Avoids collapsing a sub-LSB signal through undithered quantization |
| ZIP export | Original entry bytes preserved | Archiving does not alter audio |

Peak protection measures the input, applies only necessary negative gain, then checks the encoded output. It can correct the gain and encode again from the original input, with a maximum of three attempts. It rejects an unverifiable or out-of-target result. It does not repeatedly transcode an already encoded output, boost quiet music, normalize playlist loudness, or repair clipping already present in a master. Original remains untouched.

## Account experience

1. Download/open the updated desktop helper and connect it to the web app.
2. Expand **Connect accounts for better sources** and choose the browser containing the service login.
3. Open YouTube Music or SoundCloud, sign in in that browser, play the track, and select High quality if the subscription supports it.
4. Choose **Use this account**, then re-import the link. The extractor automatically evaluates streams available to that account.
5. If the browser blocks cookie access, close it and approve the operating-system keychain prompt, or use Firefox. The wizard supports default profiles.

Cookie access is opt-in and provider-scoped in use. The extraction tool reads browser cookies locally; the app stores only selected browser names. Session data is not uploaded to Netlify, and authenticated extraction disk caches are disabled. Disconnecting removes the preference and invalidates extraction caches, but does not sign the listener out of the service. The application never asks for service passwords.

Opted-in Google lookups include the YouTube Music client alongside the extractor’s account-aware defaults, even after shared links are normalized. Google/YouTube Music and SoundCloud subscriptions can expose better entitled streams or original downloads. Availability is track- and account-dependent, and browser encryption may prevent session extraction. Spotify, Apple Music and Amazon Music authentication does not expose downloadable full-track audio through this implementation; those imports continue to use identified matched recordings. Protected/encrypted streams remain unsupported.

## Operating limits and tradeoffs

- Loudness/peak measurement is not proof that the source master is unclipped, authentic, lossless or audibly transparent. Existing distortion cannot be reversed by attenuation or conversion.
- Bitrate is not directly comparable across codecs. Source bitrate comes from extractor metadata; measured file averages may include container overhead. VBR rates vary with the material.
- Original downloads retain their fast path. Their detailed measurement is on request. Explicit conversions are measured after encoding; optional peak protection adds analysis and potentially additional encoding passes.
- Opus conversion supports mono/stereo at 48 kHz. Surround sources should use Original. MP3 does not support a 96 kHz output rate.
- An alternate upload can be a different version or master. Provenance is visible, but the app does not prove audio identity through fingerprinting or access the original master for comparison.
- External music services and authenticated premium accounts could not be exercised live from the restricted development network. Controlled source tests and real local encoding/measurement tests establish implementation behavior; they do not establish universal upstream access.

## Release and assurance

The application and desktop helper must be updated together for account access and the new extraction rules. The web app detects older helper protocol versions and prompts for an update. The desktop release workflow builds Windows, Mac and Linux packages and checks their bundled runtimes without an installed Node/Python toolchain. Account functionality still requires the listener's own supported browser and login.

Local validation passed TypeScript checking, 73 unit/regression checks, 19 real browser tests, native FFmpeg comparisons, and the packaged Linux helper runtime check with an empty PATH. See the commit's checks for the final release status. No claim of perfection or guaranteed premium access is made: the release provides stronger defaults, observable measurements and concrete regression checks.

## Real-track measurements, 5 November 2026

Current Windows validation after the protected-FLAC and browser-extension changes: production build, TypeScript, 92 unit/integration tests and 21 app browser tests passed. Native FFmpeg independently measured the default FLAC stress export at -1.2 dBTP from a +2.9 dBTP input; FFprobe confirmed 24-bit FLAC and unchanged 44.1 kHz rate. A real Chromium extension test verifies pairing, session transfer, helper restart recovery, and disconnect using a disposable profile with fixture cookies. The listener's live Premium login and actual entitled formats have not been verified. The helper now bundles an optional Chrome/Edge extension; see [browser extension setup](browser-extension.md).

Five tracks from YouTube and SoundCloud, exported through the shipped WASM engine and analysed separately with native FFmpeg. A small sample, not a survey.

| Check | Before | After | Note |
| --- | --- | --- | --- |
| Stream selection | Best listed format chosen | Unchanged | Opus ≈164 kbps of 7 YouTube formats; AAC 160 kbps of 2 SoundCloud formats, without a subscription |
| Overs in decoded lossy audio | 3 of 5 tracks above 0 dBFS, up to +3.16 dB; protection off by default | Protection on by default: −1.2 dBTP, no flat-topped runs | Lowers level only when needed; Original stays untouched and can still contain overs |
| 44.1→48 kHz image | −23.4 dB | −61.5 dB | 256-tap Kaiser filter; about 4.6× slower on a 2.5-minute track (2.1 s to 9.6 s in Node) |
| 21.5 kHz passband, 44.1→48 kHz | −3.61 dB | −0.04 dB | Same filter |
| AAC encoder flags (`aac_pns`, `aac_is`, `aac_tns`, `aac_ms`) | Null-test SNR 23.0–29.7 dB | Not adopted | At most 0.4 dB better, and disabling mid/side was worse |

Open items: FFmpeg's native AAC scored lowest in null tests (23–42 dB, against 30–47 dB for MP3 at the same target). Null tests measure waveform difference, not audibility. AAC output from WebM input also sits 336 samples (7 ms) late; the cause is not established. Opus has no content above 20 kHz by design. None of this exceeds the source: a source lowpassed at 16 kHz stays lowpassed at 16 kHz.
