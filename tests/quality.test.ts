import { describe, it, expect } from "vitest";
import {
  parseMeasurement,
  headroomAdjustment,
  durationWarning,
} from "../src/lib/quality";
import { conversionArgs, defaults } from "../src/lib/model";
describe("quality decisions and meters", () => {
  it("preserves source by default and uses maximum encoder settings", () => {
    expect(defaults).toMatchObject({
      format: "original",
      sampleRate: "source",
      bitrate: "320",
      bitDepth: "24",
      preventClipping: false,
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
