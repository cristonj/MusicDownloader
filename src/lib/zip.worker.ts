/// <reference lib="webworker" />
import { zipSync } from "fflate";
import { safeFilename } from "./model";
self.onmessage = (
  event: MessageEvent<{ name: string; buffer: ArrayBuffer }[]>,
) => {
  try {
    const files: Record<string, Uint8Array> = Object.create(null);
    for (const { name, buffer } of event.data) {
      const base = safeFilename(name);
      let unique = base;
      let index = 2;
      while (Object.hasOwn(files, unique)) {
        const dot = base.lastIndexOf(".");
        unique =
          dot > 0
            ? `${base.slice(0, dot)} (${index++})${base.slice(dot)}`
            : `${base} (${index++})`;
      }
      files[unique] = new Uint8Array(buffer);
    }
    const zipped = zipSync(files, { level: 0 });
    self.postMessage({ data: zipped }, { transfer: [zipped.buffer] });
  } catch {
    self.postMessage({
      error: "Not enough memory to create this ZIP. Try a smaller batch.",
    });
  }
};
