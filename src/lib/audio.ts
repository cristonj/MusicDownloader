import type { FFmpeg } from "@ffmpeg/ffmpeg";
import {
  conversionArgs,
  resampleFilter,
  type Preferences,
  type Track,
} from "./model";
// Each engine is its own worker, so several tracks convert in parallel on
// multi-core devices. Engines are reused across tracks once loaded.
export const CONVERSION_SLOTS =
  typeof navigator === "undefined"
    ? 1
    : Math.max(
        1,
        Math.min(3, Math.floor((navigator.hardwareConcurrency || 2) / 2)),
      );
const idle: FFmpeg[] = [];
const busy = new Set<FFmpeg>();

export function cancelConversion() {
  for (const engine of [...idle, ...busy]) engine.terminate();
  idle.length = 0;
  busy.clear();
}
async function getEngine(
  signal: AbortSignal,
  onStatus: (message: string) => void,
): Promise<FFmpeg> {
  const ready = idle.pop();
  if (ready?.loaded) {
    busy.add(ready);
    return ready;
  }
  onStatus("Loading the on-device audio engine…");
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const next = new FFmpeg();
  busy.add(next);
  try {
    await next.load({
      coreURL: `${location.origin}/ffmpeg/ffmpeg-core.js`,
      wasmURL: `${location.origin}/ffmpeg/ffmpeg-core.wasm`,
    });
  } catch (error) {
    busy.delete(next);
    next.terminate();
    throw error;
  }
  return next;
}
function releaseEngine(engine: FFmpeg, broken: boolean) {
  if (!busy.delete(engine)) return;
  if (broken) engine.terminate();
  else idle.push(engine);
}
import {
  parseMeasurement,
  headroomAdjustment,
  spectralCutoff,
  type AudioMeasurement,
} from "./quality";

async function measureFile(
  ffmpeg: FFmpeg,
  file: string,
  bytes: number,
): Promise<AudioMeasurement> {
  let log = "";
  const listener = ({ message }: { message: string }) => {
    log += message + "\n";
  };
  ffmpeg.on("log", listener);
  try {
    const code = await ffmpeg.exec([
      "-hide_banner",
      "-nostats",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-vn",
      "-af",
      "ebur128=peak=true:framelog=verbose,astats=metadata=0:reset=0",
      "-f",
      "null",
      "-",
    ]);
    if (code !== 0) throw new Error("This audio could not be measured.");
    return parseMeasurement(log, bytes);
  } finally {
    ffmpeg.off("log", listener);
  }
}
// Up to two minutes from the middle of the track is plenty to find a cutoff,
// and keeps a long mix from exhausting memory. It only ever adds information,
// so a failure leaves the rest of the measurement or export untouched.
const SPECTRUM_SECONDS = 120;
async function measureSpectrum(
  ffmpeg: FFmpeg,
  file: string,
  duration: number | undefined,
  sampleRate: number | undefined,
): Promise<Pick<AudioMeasurement, "cutoffHz" | "spectrumMeasured">> {
  if (!sampleRate) return {};
  try {
    const start =
      duration && duration > SPECTRUM_SECONDS
        ? (duration - SPECTRUM_SECONDS) / 2
        : 0;
    const code = await ffmpeg.exec([
      "-y",
      ...(start ? ["-ss", start.toFixed(2)] : []),
      "-i",
      file,
      "-map",
      "0:a:0",
      "-vn",
      "-t",
      String(SPECTRUM_SECONDS),
      "-ac",
      "1",
      "-c:a",
      "pcm_f32le",
      "-f",
      "f32le",
      "spectrum.pcm",
    ]);
    if (code !== 0) return {};
    const pcm = await ffmpeg.readFile("spectrum.pcm");
    if (typeof pcm === "string" || pcm.length < 4) return {};
    const samples = new Float32Array(
      pcm.buffer.slice(
        pcm.byteOffset,
        pcm.byteOffset + (pcm.length & ~3),
      ) as ArrayBuffer,
    );
    return {
      cutoffHz: spectralCutoff(samples, sampleRate),
      spectrumMeasured: true,
    };
  } catch {
    return {};
  } finally {
    await ffmpeg.deleteFile("spectrum.pcm").catch(() => {});
  }
}
export async function analyzeAudio(
  input: Blob,
  extension: string,
  signal: AbortSignal,
): Promise<AudioMeasurement> {
  const ffmpeg = await getEngine(signal, () => {});
  let broken = false;
  const abort = () => ffmpeg.terminate();
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    await ffmpeg.writeFile(
      `measure.${extension}`,
      new Uint8Array(await input.arrayBuffer()),
    );
    const measured = await measureFile(
      ffmpeg,
      `measure.${extension}`,
      input.size,
    );
    return {
      ...measured,
      sourceCodec: measured.codec,
      ...(await measureSpectrum(
        ffmpeg,
        `measure.${extension}`,
        measured.duration,
        measured.sampleRate,
      )),
    };
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await ffmpeg.deleteFile(`measure.${extension}`).catch(() => {});
    releaseEngine(ffmpeg, broken);
  }
}
// Measures the frequency range of a partial download, for comparing sources.
export async function analyzeSample(
  input: Blob,
  extension: string,
  signal: AbortSignal,
): Promise<{ cutoffHz?: number; measured: boolean }> {
  const ffmpeg = await getEngine(signal, () => {});
  const name = `sample.${extension}`;
  let broken = false;
  const abort = () => ffmpeg.terminate();
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    await ffmpeg.writeFile(name, new Uint8Array(await input.arrayBuffer()));
    const info = await measureFile(ffmpeg, name, input.size);
    const spectrum = await measureSpectrum(
      ffmpeg,
      name,
      undefined,
      info.sampleRate,
    );
    return {
      cutoffHz: spectrum.cutoffHz,
      measured: Boolean(spectrum.spectrumMeasured),
    };
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await ffmpeg.deleteFile(name).catch(() => {});
    releaseEngine(ffmpeg, broken);
  }
}
async function encodeOpus(
  pcm: Uint8Array,
  channels: 1 | 2,
  track: Track,
  bitrate: number,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./opus.worker.ts", import.meta.url));
    const cleanup = () => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({
      data,
    }: MessageEvent<{ blob?: Blob; error?: string; progress?: number }>) => {
      if (data.progress !== undefined) onProgress(data.progress);
      if (data.blob || data.error) {
        cleanup();
        data.blob ? resolve(data.blob) : reject(new Error(data.error));
      }
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error("The Opus encoder stopped. Try again."));
    };
    const floats = new Float32Array(new Uint8Array(pcm).buffer);
    worker.postMessage(
      {
        pcm: floats,
        channels,
        bitrate,
        title: track.title,
        artist: track.artist,
      },
      [floats.buffer],
    );
    if (signal.aborted) abort();
  });
}
export async function convertAudio(
  input: Blob,
  track: Track,
  prefs: Preferences,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
  onStatus: (message: string) => void,
  remuxTo?: string,
  onMeasurement?: (value: AudioMeasurement) => void,
): Promise<Blob> {
  if (prefs.format === "original" && !remuxTo) return input;
  const ffmpeg = await getEngine(signal, onStatus);
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const inputName = `input.${track.extension}`;
  const outputFormat = prefs.format === "original" ? remuxTo! : prefs.format;
  const outputName = `output.${outputFormat}`;
  const listener = ({ progress }: { progress: number }) =>
    onProgress(Math.max(0, Math.min(0.99, progress)));
  ffmpeg.on("progress", listener);
  let broken = false;
  try {
    onStatus(`Converting ${track.title} on your device…`);
    await ffmpeg.writeFile(
      inputName,
      new Uint8Array(await input.arrayBuffer()),
    );
    const original = prefs.format === "original";
    const protect = !original && prefs.preventClipping;
    const inputMeasurement = protect
      ? await measureFile(ffmpeg, inputName, input.size)
      : undefined;
    if (
      protect &&
      inputMeasurement?.truePeakDbtp !== -Infinity &&
      !Number.isFinite(inputMeasurement?.truePeakDbtp)
    )
      throw new Error(
        "Could not measure the source peaks for protected export. Try another source.",
      );
    // The source's range, before dither adds a noise floor to the output.
    const sourceInfo = original
      ? undefined
      : inputMeasurement || (await measureFile(ffmpeg, inputName, input.size));
    const sourceSpectrum = sourceInfo
      ? await measureSpectrum(
          ffmpeg,
          inputName,
          sourceInfo.duration,
          sourceInfo.sampleRate,
        )
      : {};
    let gain = protect
      ? headroomAdjustment(inputMeasurement?.truePeakDbtp, -1.2)
      : 0;
    let result: Uint8Array<ArrayBuffer> | undefined;
    let measured: AudioMeasurement | undefined;
    for (let pass = 0; pass < (protect ? 3 : 1); pass++) {
      const filters = [
        ...(gain < 0 ? [`volume=${gain.toFixed(6)}dB:precision=double`] : []),
        ...(prefs.sampleRate !== "source" && outputFormat !== "opus" && !original
          ? [resampleFilter(prefs.sampleRate)]
          : []),
        ...(["flac", "wav", "aiff"].includes(outputFormat)
          ? [
              `aresample=dither_method=triangular:output_sample_bits=${prefs.bitDepth}`,
            ]
          : []),
      ];
      let args = original
        ? ["-map", "0:a:0", "-vn", "-c:a", "copy"]
        : conversionArgs(prefs);
      // Install the combined filter once (volume must precede quantization).
      const af = args.indexOf("-af");
      if (af >= 0) args.splice(af, 2);
      if (!original && filters.length) args.push("-af", filters.join(","));
      const metadata = [
        "-map_metadata",
        "0",
        ...(track.provider === "Local file"
          ? []
          : [
              "-metadata",
              `title=${track.title}`,
              ...(track.artist ? ["-metadata", `artist=${track.artist}`] : []),
            ]),
      ];
      if (!original && outputFormat === "opus") {
        // Decode/resample in float, then encode with modern libopus in a
        // separate worker. No unstable FFmpeg libopus/native-Opus workaround.
        const inputInfo =
          inputMeasurement || await measureFile(ffmpeg, inputName, input.size);
        if (inputInfo.channels && inputInfo.channels > 2)
          throw new Error(
            "Opus export supports mono or stereo. Choose Original to preserve surround audio.",
          );
        const channels = inputInfo.channels === 1 ? 1 : 2;
        const code = await ffmpeg.exec([
          "-y",
          "-i",
          inputName,
          "-map",
          "0:a:0",
          "-vn",
          "-af",
          [
            ...(gain < 0 ? [`volume=${gain.toFixed(6)}dB:precision=double`] : []),
            resampleFilter(48000),
          ].join(","),
          "-ac",
          String(channels),
          "-c:a",
          "pcm_f32le",
          "-f",
          "f32le",
          "opus.pcm",
        ]);
        if (code !== 0)
          throw new Error("This audio could not be decoded for Opus.");
        const pcm = await ffmpeg.readFile("opus.pcm");
        if (typeof pcm === "string") throw new Error("Invalid decoded audio.");
        const blob = await encodeOpus(
          pcm,
          channels,
          track,
          +prefs.bitrate * 1000,
          signal,
          onProgress,
        );
        await ffmpeg.deleteFile("opus.pcm");
        result = new Uint8Array(await blob.arrayBuffer());
        await ffmpeg.writeFile(outputName, new Uint8Array(result));
      } else {
        const code = await ffmpeg.exec([
          "-y",
          "-i",
          inputName,
          ...args,
          ...metadata,
          outputName,
        ]);
        if (code !== 0)
          throw new Error(
            "This audio could not be converted. Try Original or another format.",
          );
        const bytes = await ffmpeg.readFile(outputName);
        if (typeof bytes === "string")
          throw new Error("The audio engine returned invalid output.");
        result = new Uint8Array(bytes);
      }
      // Original remuxes remain untouched and fast. Conversions are measured
      // after encoding; protection is verified against the actual output.
      if (!original)
        measured = await measureFile(ffmpeg, outputName, result.length);
      if (
        !protect ||
        measured?.truePeakDbtp === -Infinity ||
        (Number.isFinite(measured?.truePeakDbtp) &&
          measured!.truePeakDbtp! <= -1)
      )
        break;
      if (!Number.isFinite(measured?.truePeakDbtp))
        throw new Error(
          "Could not verify peak protection. Choose Original or turn protection off.",
        );
      gain += headroomAdjustment(measured!.truePeakDbtp, -1.2);
    }
    if (
      protect &&
      measured?.truePeakDbtp !== undefined &&
      measured.truePeakDbtp > -1
    )
      throw new Error(
        "Peak protection could not reach its target. Choose Original or another format.",
      );
    if (measured)
      onMeasurement?.({
        ...measured,
        attenuationDb: gain,
        sourceCodec: sourceInfo?.codec,
        ...sourceSpectrum,
      });
    if (!result) throw new Error("The audio engine returned no audio.");
    const types: Record<string, string> = {
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      wav: "audio/wav",
      flac: "audio/flac",
      ogg: "audio/ogg",
      opus: "audio/ogg",
      aiff: "audio/aiff",
    };
    return new Blob([new Uint8Array(result)], { type: types[outputFormat] });
  } catch (error) {
    broken = true;
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (
      error instanceof RangeError ||
      /memory|allocation|out of bounds/i.test(String(error))
    )
      throw new Error(
        "This device ran out of memory converting the audio. Choose Original or convert a smaller file.",
      );
    throw error instanceof Error
      ? error
      : new Error("The audio engine stopped. Try again or choose Original.");
  } finally {
    ffmpeg.off("progress", listener);
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
    await ffmpeg.deleteFile("opus.pcm").catch(() => {});
    releaseEngine(ffmpeg, broken);
  }
}
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
export async function makeZip(
  files: { name: string; blob: Blob }[],
  signal: AbortSignal,
): Promise<Blob> {
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  // fflate writes ZIP32. Reserve room for names and directory records so a
  // multi-gigabyte export fails clearly rather than wrapping its offsets.
  if (
    files.reduce((size, file) => size + file.blob.size + 1024, 22) >= 0xffffffff
  )
    throw new Error(
      "This archive exceeds ZIP's 4 GB format limit. Download the tracks individually.",
    );
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./zip.worker.ts", import.meta.url));
    const cleanup = () => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException("Cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (
      event: MessageEvent<{ blob?: Blob; error?: string }>,
    ) => {
      cleanup();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.blob!);
    };
    worker.onerror = () => {
      cleanup();
      reject(
        new Error(
          "ZIP creation failed. Download tracks individually or use a smaller batch.",
        ),
      );
    };
    worker.postMessage(files);
  });
}
