/// <reference lib="webworker" />
type OpusLibrary = typeof import("libopus-wasm");
import { oggPage, opusHead, opusTags } from "./ogg-opus";
self.onmessage = async ({
  data,
}: MessageEvent<{
  pcm: Float32Array;
  channels: 1 | 2;
  bitrate: number;
  title: string;
  artist: string;
}>) => {
  let encoder: Awaited<ReturnType<OpusLibrary["createEncoder"]>> | undefined;
  try {
    // Keep Emscripten's conditional Node imports out of the browser bundler.
    const { createEncoder, Application, Signal }: OpusLibrary = await import(
      /* webpackIgnore: true */ `${self.location.origin}/opus/index.js`
    );
    encoder = await createEncoder({
      sampleRate: 48000,
      channels: data.channels,
      application: Application.Audio,
      signal: Signal.Music,
      bitrate: data.bitrate,
      complexity: 10,
      vbr: true,
    });
    const preSkip = encoder.getLookahead(),
      serial = crypto.getRandomValues(new Uint32Array(1))[0];
    const pages: BlobPart[] = [
      oggPage([opusHead(data.channels, preSkip)], serial, 0, 0, 2),
      oggPage([opusTags(data.title, data.artist)], serial, 1, 0),
    ];
    const samples = data.pcm.length / data.channels,
      frame = encoder.frameSize;
    const frames = Math.ceil((samples + preSkip) / frame);
    let sequence = 2;
    let packets: Uint8Array[] = [];
    for (let index = 0; index < frames; index++) {
      const pcm = new Float32Array(frame * data.channels);
      pcm.set(data.pcm.subarray(index * pcm.length, (index + 1) * pcm.length));
      packets.push(encoder.encodeFloat(pcm));
      if (packets.length === 20 || index === frames - 1) {
        const final = index === frames - 1;
        pages.push(
          oggPage(
            packets,
            serial,
            sequence++,
            final ? samples + preSkip : (index + 1) * frame,
            final ? 4 : 0,
          ),
        );
        packets = [];
        self.postMessage({ progress: (index + 1) / frames });
      }
    }
    self.postMessage({ blob: new Blob(pages, { type: "audio/ogg" }) });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : "Opus encoding failed.",
    });
  } finally {
    encoder?.free();
  }
};
