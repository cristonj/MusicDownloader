/// <reference lib="webworker" />
import { Zip, ZipPassThrough } from "fflate";
import { safeFilename } from "./model";
self.onmessage = async (
  event: MessageEvent<{ name: string; blob: Blob }[]>,
) => {
  const parts: Blob[] = [];
  const names = new Set<string>();
  const zip = new Zip((error, data, final) => {
    if (error) throw error;
    // Blob parts let the browser spill large archives to disk instead of
    // allocating every input and the complete ZIP in contiguous JS memory.
    parts.push(new Blob([new Uint8Array(data)]));
    if (final)
      self.postMessage({ blob: new Blob(parts, { type: "application/zip" }) });
  });
  try {
    for (const { name, blob } of event.data) {
      const base = safeFilename(name);
      let unique = base;
      let index = 2;
      while (names.has(unique)) {
        const dot = base.lastIndexOf(".");
        unique =
          dot > 0
            ? `${base.slice(0, dot)} (${index++})${base.slice(dot)}`
            : `${base} (${index++})`;
      }
      names.add(unique);
      const entry = new ZipPassThrough(unique);
      zip.add(entry);
      const reader = blob.stream().getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          entry.push(value);
        }
        entry.push(new Uint8Array(), true);
      } finally {
        await reader.cancel().catch(() => {});
      }
    }
    zip.end();
  } catch {
    zip.terminate();
    self.postMessage({
      error:
        "This device could not create the ZIP. Download tracks individually or use a smaller batch.",
    });
  }
};
