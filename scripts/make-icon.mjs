// Draws the app mark (public/icon.svg) into a Windows .ico, so the helper
// installs and appears as an application with its own icon. Pure Node: the
// icon is five rounded bars on a rounded dark square, which is cheaper to
// rasterise here than to add an image toolchain to the build.
import { deflateSync } from "node:zlib";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
const SIZE = 256;
const BACKGROUND = [0x20, 0x25, 0x1f];
const BAR = [0xd5, 0xf8, 0x72];
// Each bar is [centre x, top y, bottom y] on the SVG's 64px grid.
const BARS = [
  [16, 27, 37],
  [24, 19, 45],
  [32, 14, 50],
  [40, 19, 35],
  [48, 22, 30],
];
const STROKE = 4;
function pixels() {
  const scale = SIZE / 64;
  const data = Buffer.alloc(SIZE * SIZE * 4);
  const radius = 18 * scale;
  const half = (STROKE / 2) * scale;
  const inside = (x, y) => {
    // Rounded square: outside only near a corner, beyond its arc.
    const dx = Math.min(x - radius, 0) || Math.max(x - (SIZE - radius), 0);
    const dy = Math.min(y - radius, 0) || Math.max(y - (SIZE - radius), 0);
    return dx * dx + dy * dy <= radius * radius;
  };
  const onBar = (x, y) => {
    for (const [cx, top, bottom] of BARS) {
      const bx = cx * scale,
        by1 = top * scale,
        by2 = bottom * scale;
      // A round-capped line is every point within half a stroke of it.
      const dy = y < by1 ? y - by1 : y > by2 ? y - by2 : 0;
      const dx = x - bx;
      if (dx * dx + dy * dy <= half * half) return true;
    }
    return false;
  };
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const at = (y * SIZE + x) * 4;
      // Four samples a pixel smooth the curves enough at this size.
      let covered = 0,
        lit = 0;
      for (const [ox, oy] of [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ]) {
        if (!inside(x + ox, y + oy)) continue;
        covered++;
        if (onBar(x + ox, y + oy)) lit++;
      }
      if (!covered) continue;
      const mix = lit / covered;
      for (let channel = 0; channel < 3; channel++)
        data[at + channel] = Math.round(
          BACKGROUND[channel] * (1 - mix) + BAR[channel] * mix,
        );
      data[at + 3] = Math.round((covered / 4) * 255);
    }
  return data;
}
function png(data) {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    data.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const payload = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(payload) >>> 0);
    return Buffer.concat([length, payload, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
let table;
function crc32(buffer) {
  if (!table)
    table = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit++)
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      return value >>> 0;
    });
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export async function writeIcon(path) {
  const image = png(pixels());
  // An .ico may hold a PNG directly; Windows scales the 256px frame down.
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0;
  entry[1] = 0;
  entry[4] = 1;
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(22, 12);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.concat([header, entry, image]));
  return path;
}
if (
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())
)
  console.log(
    `Wrote ${await writeIcon(process.argv[2] || ".helper-build/app.ico")}`,
  );
