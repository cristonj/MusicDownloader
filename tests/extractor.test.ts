import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
beforeEach(() => {
  vi.resetModules();
  spawn.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
function fakeResult(value: unknown) {
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(JSON.stringify(value)));
      child.emit("close", 0);
    });
    return child;
  });
}
describe("fast source lookups", () => {
  it("shares concurrent lookups and reuses single-track metadata for audio", async () => {
    fakeResult({
      title: "A song",
      url: "https://r1.googlevideo.com/audio",
      protocol: "https",
      ext: "m4a",
    });
    const { extract } = await import("../src/server/extractor");
    await Promise.all([
      extract("https://youtube.com/watch?v=abcdefghijk", true),
      extract("https://youtube.com/watch?v=abcdefghijk", true),
      extract("https://youtube.com/watch?v=abcdefghijk", true),
    ]);
    await extract("https://youtube.com/watch?v=abcdefghijk", false);
    expect(spawn).toHaveBeenCalledTimes(1);
    const args = spawn.mock.calls[0][1] as string[];
    expect(args).toContain("--ignore-config");
    expect(args).toContain("--use-extractors");
    expect(args).toContain("-f");
  });
  it("does not mistake a playlist for a single audio source", async () => {
    fakeResult({ entries: [{ title: "Song", id: "abcdefghijk" }] });
    const { extract } = await import("../src/server/extractor");
    await extract("https://youtube.com/playlist?list=example", true);
    await extract("https://youtube.com/playlist?list=example", false);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

it("retries other YouTube clients automatically when the default has no playable formats", async () => {
  spawn.mockImplementation((_binary: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      if (args.includes("youtube:player_client=web_embedded")) {
        child.stdout.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              title: "Recovered recording",
              url: "https://r1.googlevideo.com/audio",
              ext: "m4a",
            }),
          ),
        );
        child.emit("close", 0);
      } else {
        child.stderr.emit(
          "data",
          Buffer.from("ERROR: Requested format is not available"),
        );
        child.emit("close", 1);
      }
    });
    return child;
  });
  const { extract } = await import("../src/server/extractor");
  expect(
    (await extract("https://www.youtube.com/watch?v=xKJtIjB3pAI")).title,
  ).toBe("Recovered recording");
  expect(spawn).toHaveBeenCalledTimes(3);
});
it("does not mislabel a runtime failure as a private track or retry a broken engine", async () => {
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      child.stderr.emit(
        "data",
        Buffer.from("Failed to load Python shared library"),
      );
      child.emit("close", 1);
    });
    return child;
  });
  const { extract } = await import("../src/server/extractor");
  await expect(
    extract("https://www.youtube.com/watch?v=xKJtIjB3pAI"),
  ).rejects.toThrow("download engine could not run");
  expect(spawn).toHaveBeenCalledTimes(1);
});
