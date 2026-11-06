import { describe, expect, it } from "vitest";
import { sourceVerdict, spectralCutoff } from "../src/lib/quality";
import { readArtistOffer } from "../src/server/soundcloud";

// Evenly spaced partials falling at about 3 dB per octave, like music.
function tones(rate: number, topHz: number, seconds = 8, floor = 1e-7) {
  const samples = new Float32Array(rate * seconds);
  const partials: [number, number][] = [];
  for (let hz = 200; hz < topHz; hz += 83)
    partials.push([hz, 0.02 / Math.sqrt(hz / 200)]);
  for (let i = 0; i < samples.length; i += 1) {
    let value = 0;
    for (const [hz, amp] of partials)
      value += amp * Math.sin((2 * Math.PI * hz * i) / rate + hz);
    samples[i] = value + floor * (Math.random() * 2 - 1);
  }
  return samples;
}

describe("spectral cutoff", () => {
  it("finds the wall a lossy encoder leaves", () => {
    const opusLike = spectralCutoff(tones(48000, 20000, 2), 48000);
    const aacLike = spectralCutoff(tones(44100, 16000, 2), 44100);
    expect(Math.abs(opusLike! - 20000)).toBeLessThanOrEqual(500);
    expect(Math.abs(aacLike! - 16000)).toBeLessThanOrEqual(500);
  });
  it("reports no cutoff when audio reaches the top of the band", () => {
    expect(spectralCutoff(tones(44100, 22050, 2), 44100)).toBeUndefined();
  });
  it("doesn't mistake silence or a tiny clip for a cutoff", () => {
    expect(spectralCutoff(new Float32Array(48000), 48000)).toBeUndefined();
    expect(spectralCutoff(new Float32Array(100), 48000)).toBeUndefined();
  });
  it("says what a lossy source can and can't become", () => {
    expect(
      sourceVerdict({
        spectrumMeasured: true,
        sourceCodec: "opus",
        cutoffHz: 20000,
      }),
    ).toMatch(/Lossy source \(opus\): audio ends at 20 kHz.*checkers will flag/);
    expect(
      sourceVerdict({
        spectrumMeasured: true,
        sourceCodec: "flac",
        cutoffHz: 16000,
      }),
    ).toMatch(/usually means it came from a lossy file/);
    expect(
      sourceVerdict({ spectrumMeasured: true, sourceCodec: "flac" }),
    ).toMatch(/doesn’t prove/);
    expect(sourceVerdict({ sourceCodec: "flac" })).toBeUndefined();
  });
});

describe("artist offers", () => {
  const page = (sound: unknown) =>
    `<script>window.__sc_hydration = ${JSON.stringify([
      { hydratable: "sound", data: sound },
    ])};</script>`;
  it("reads an enabled original and the artist's link", () => {
    expect(
      readArtistOffer(
        page({
          downloadable: true,
          has_downloads_left: true,
          purchase_title: "Free Download",
          purchase_url: "https://hypeddit.com/blueberry",
        }),
      ),
    ).toEqual({
      originalDownload: true,
      artistLink: {
        url: "https://hypeddit.com/blueberry",
        label: "Free Download",
      },
    });
  });
  it("ignores spent downloads and unsafe links", () => {
    expect(
      readArtistOffer(
        page({
          downloadable: true,
          has_downloads_left: false,
          purchase_url: "javascript:alert(1)",
        }),
      ),
    ).toEqual({});
    expect(readArtistOffer("<html></html>")).toEqual({});
  });
});
