import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
beforeEach(() => {
  vi.resetModules();
  spawn.mockReset();
});
function fakeResult(value: unknown) {
  spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
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
