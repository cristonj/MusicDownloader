import { describe, expect, it } from "vitest";
import {
  conversionArgs,
  resampleFilter,
  defaults,
  outputFilename,
  parseUrl,
  providerFor,
  readPreferences,
  safeFilename,
} from "../src/lib/model";

describe("source boundaries", () => {
  it("recognizes service hosts without accepting lookalike domains", () => {
    expect(providerFor(parseUrl("https://music.youtube.com/watch?v=x"))).toBe(
      "YouTube",
    );
    expect(
      providerFor(parseUrl("https://artist.bandcamp.com/album/demo")),
    ).toBe("Bandcamp");
    expect(
      providerFor(parseUrl("https://youtube.com.attacker.test/file.mp3")),
    ).toBe("Direct link");
  });
  it("rejects script URLs and embedded credentials", () => {
    expect(() => parseUrl("javascript:alert(1)")).toThrow();
    expect(() =>
      parseUrl("https://user:password@example.com/file.mp3"),
    ).toThrow();
  });
});
describe("export decisions", () => {
  it("does not transcode originals", () =>
    expect(conversionArgs({ ...defaults, format: "original" })).toEqual([]));
  it("uses real codecs and honors sample rate and bit depth", () => {
    expect(
      conversionArgs({ ...defaults, format: "mp3", bitrate: "192" }),
    ).toContain("192k");
    expect(
      conversionArgs({
        ...defaults,
        format: "wav",
        bitDepth: "24",
        sampleRate: "96000",
      }),
    ).toEqual([
      "-map",
      "0:a:0",
      "-vn",
      "-c:a",
      "pcm_s24le",
      "-af",
      `${resampleFilter("96000")},aresample=dither_method=triangular`,
    ]);
    expect(
      conversionArgs({ ...defaults, format: "opus", sampleRate: "96000" }),
    ).not.toContain("96000");
  });
  it("cleans path traversal, illegal filenames and device names", () => {
    expect(safeFilename("../../music")).not.toContain("/");
    expect(safeFilename("CON")).toBe("_CON");
    expect(
      outputFilename(
        { title: "Song/One", artist: "Artist", extension: "wav" },
        "mp3",
      ),
    ).toBe("Artist - Song_One.mp3");
  });
  it("turns peak protection on for settings saved before it was the default", () => {
    expect(readPreferences('{"preventClipping":false}').preventClipping).toBe(true);
    expect(
      readPreferences('{"prefsVersion":2,"preventClipping":false}').preventClipping,
    ).toBe(false);
  });
  it("ignores corrupt or unsupported saved settings", () => {
    expect(readPreferences("{")).toEqual(defaults);
    expect(readPreferences('{"format":"exe","bitrate":"1000000"}')).toEqual(
      defaults,
    );
  });
  it("upgrades the old original default to protected FLAC and retains a new explicit original choice", () => {
    expect(readPreferences(JSON.stringify({ format: "original", prefsVersion: 2,
      bitDepth: "16", sampleRate: "96000", preventClipping: false,
    }))).toMatchObject({ format: "flac", bitDepth: "24", sampleRate: "source", preventClipping: true });
    expect(readPreferences(JSON.stringify({ ...defaults, format: "original" })).format).toBe("original");
  });
});
