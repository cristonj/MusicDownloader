import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { conversionArgs, type Preferences, type Track } from "./model";
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
// Re-encoding is the slow part; when the source already uses the requested
// codec at its own sample rate, copying the audio is near-instant.
function copiesAs(extension: string, prefs: Preferences) {
  if (prefs.sampleRate !== "source") return false;
  const sources: Partial<Record<Preferences["format"], string[]>> = {
    m4a: ["m4a", "mp4", "aac"],
    opus: ["webm", "opus"],
    mp3: ["mp3"],
  };
  return sources[prefs.format]?.includes(extension.toLowerCase()) ?? false;
}
export async function convertAudio(
  input: Blob,
  track: Track,
  prefs: Preferences,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
  onStatus: (message: string) => void,
  remuxTo?: string,
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
    const code = await ffmpeg.exec([
      "-i",
      inputName,
      ...(prefs.format === "original" || copiesAs(track.extension, prefs)
        ? ["-map", "0:a:0", "-vn", "-c:a", "copy"]
        : conversionArgs(prefs)),
      "-map_metadata",
      "0",
      ...(track.provider === "Local file"
        ? []
        : [
            "-metadata",
            `title=${track.title}`,
            ...(track.artist ? ["-metadata", `artist=${track.artist}`] : []),
          ]),
      outputName,
    ]);
    if (code !== 0) {
      throw new Error(
        "This audio could not be converted. Try Original or another format.",
      );
    }
    const result = await ffmpeg.readFile(outputName);
    if (typeof result === "string")
      throw new Error("The audio engine returned invalid output.");
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
