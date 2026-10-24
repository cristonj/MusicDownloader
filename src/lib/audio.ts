import type { FFmpeg } from "@ffmpeg/ffmpeg";
import { conversionArgs, type Preferences, type Track } from "./model";
let engine: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;

export function cancelConversion() {
  engine?.terminate();
  engine = null;
  loading = null;
}
async function getEngine(
  signal: AbortSignal,
  onStatus: (message: string) => void,
): Promise<FFmpeg> {
  if (engine?.loaded) return engine;
  if (!loading) {
    loading = (async () => {
      onStatus("Loading the on-device audio engine…");
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const next = new FFmpeg();
      engine = next;
      await next.load({
        coreURL: `${location.origin}/ffmpeg/ffmpeg-core.js`,
        wasmURL: `${location.origin}/ffmpeg/ffmpeg-core.wasm`,
      });
      return next;
    })().catch((error) => {
      loading = null;
      throw error;
    });
  }
  return loading;
}
export async function convertAudio(
  input: Blob,
  track: Track,
  prefs: Preferences,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
  onStatus: (message: string) => void,
): Promise<Blob> {
  if (prefs.format === "original") return input;
  const ffmpeg = await getEngine(signal, onStatus);
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const inputName = `input.${track.extension}`;
  const outputName = `output.${prefs.format}`;
  const listener = ({ progress }: { progress: number }) =>
    onProgress(Math.max(0, Math.min(0.99, progress)));
  ffmpeg.on("progress", listener);
  try {
    onStatus(`Converting ${track.title} on your device…`);
    await ffmpeg.writeFile(
      inputName,
      new Uint8Array(await input.arrayBuffer()),
    );
    const code = await ffmpeg.exec([
      "-i",
      inputName,
      ...conversionArgs(prefs),
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
    return new Blob([new Uint8Array(result)], { type: types[prefs.format] });
  } catch (error) {
    cancelConversion();
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    throw error instanceof Error
      ? error
      : new Error("The audio engine stopped. Try again or choose Original.");
  } finally {
    ffmpeg.off("progress", listener);
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
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
  const buffers = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      buffer: await file.blob.arrayBuffer(),
    })),
  );
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
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
      event: MessageEvent<{ data?: Uint8Array<ArrayBuffer>; error?: string }>,
    ) => {
      cleanup();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(new Blob([event.data.data!], { type: "application/zip" }));
    };
    worker.onerror = () => {
      cleanup();
      reject(
        new Error(
          "ZIP creation failed. Download tracks individually or use a smaller batch.",
        ),
      );
    };
    worker.postMessage(
      buffers,
      buffers.map((file) => file.buffer),
    );
  });
}
