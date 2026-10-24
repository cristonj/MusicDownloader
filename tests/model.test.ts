import { describe, expect, it } from "vitest";
import {
  conversionArgs,
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
    expect(conversionArgs(defaults)).toEqual([]));
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
    ).toEqual(["-map", "0:a:0", "-vn", "-c:a", "pcm_s24le", "-ar", "96000"]);
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
  it("ignores corrupt or unsupported saved settings", () => {
    expect(readPreferences("{")).toEqual(defaults);
    expect(readPreferences('{"format":"exe","bitrate":"1000000"}')).toEqual(
      defaults,
    );
  });
});
