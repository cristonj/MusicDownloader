import { describe, it, expect } from "vitest";
import {
  parseMeasurement,
  headroomAdjustment,
  durationWarning,
} from "../src/lib/quality";
import { conversionArgs, defaults } from "../src/lib/model";
describe("quality decisions and meters", () => {
  it("defaults to protected lossless at the source rate and uses maximum encoder settings", () => {
    expect(defaults).toMatchObject({
      format: "flac",
      sampleRate: "source",
      bitrate: "320",
      bitDepth: "24",
      preventClipping: true,
    });
    expect(conversionArgs({ ...defaults, format: "mp3" })).toContain("320k");
    expect(() =>
      conversionArgs({ ...defaults, format: "mp3", sampleRate: "96000" }),
    ).toThrow("48 kHz");
  });
  it("reads input facts and final summaries rather than intermediate meters", () => {
    const value = parseMeasurement(
      `Duration: 00:03:20.50, start: 0, bitrate: 150 kb/s
Stream #0:0: Audio: opus, 48000 Hz, stereo, fltp
I: -70.0 LUFS
Summary:
I: -9.5 LUFS
LRA: 3.2 LU
True peak:
Peak: 0.8 dBFS
[astats] Peak level dB: 0.123`,
      3200000,
    );
    expect(value).toMatchObject({
      codec: "opus",
      sampleRate: 48000,
      channels: 2,
      duration: 200.5,
      integratedLufs: -9.5,
      loudnessRangeLu: 3.2,
      truePeakDbtp: 0.8,
      samplePeakDbfs: 0.123,
    });
  });
  it("does not report the decoded output's bitrate as the file's", () => {
    const value = parseMeasurement(
      `Duration: 00:03:20.48, start: -0.007, bitrate: 118 kb/s
Stream #0:0: Audio: opus, 48000 Hz, stereo, fltp (default)
Stream mapping:
Output #0, null, to 'pipe:':
Stream #0:0: Audio: pcm_s16le, 48000 Hz, stereo, s16, 1536 kb/s`,
      2_960_000,
    );
    expect(value.codec).toBe("opus");
    expect(value.bitrateKbps).toBeCloseTo(118.1, 0);
    const aac = parseMeasurement(
      `Duration: 00:02:38.16, bitrate: 155 kb/s
Stream #0:0: Audio: aac (LC), 44100 Hz, stereo, fltp, 151 kb/s
Output #0, null, to 'pipe:':
Stream #0:0: Audio: pcm_s16le, 44100 Hz, stereo, s16, 1411 kb/s`,
      3_000_000,
    );
    expect(aac.bitrateKbps).toBe(151);
  });
  it("does not boost quiet files, mistake silence for a failed meter, or claim to repair clipping", () => {
    expect(headroomAdjustment(-4)).toBe(0);
    expect(headroomAdjustment(1)).toBe(-2);
    expect(headroomAdjustment(-Infinity)).toBe(0);
    expect(
      parseMeasurement("Peak: -inf dBFS\nPeak level dB: -inf", 0).truePeakDbtp,
    ).toBe(-Infinity);
    expect(durationWarning(240, 30)).toContain("preview");
    expect(durationWarning(240, 239)).toBeUndefined();
  });
});
