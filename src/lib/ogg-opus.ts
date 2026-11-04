// Ogg framing for raw libopus packets (RFC 7845). Granules include encoder
// lookahead; the last page trims padding so exports retain their exact length.
export function oggPage(
  packets: Uint8Array[],
  serial: number,
  sequence: number,
  granule: number,
  flags = 0,
): Uint8Array<ArrayBuffer> {
  const lacing = packets.flatMap((packet) => [
    ...Array(Math.floor(packet.length / 255)).fill(255),
    packet.length % 255,
  ]);
  if (lacing.length > 255)
    throw new Error("Too many Opus packets in one page.");
  const page = new Uint8Array(
    27 + lacing.length + packets.reduce((n, p) => n + p.length, 0),
  );
  page.set(new TextEncoder().encode("OggS"));
  const view = new DataView(page.buffer);
  page[5] = flags;
  view.setBigUint64(6, BigInt(granule), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let offset = 27 + lacing.length;
  for (const packet of packets) {
    page.set(packet, offset);
    offset += packet.length;
  }
  let crc = 0;
  for (const byte of page) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  }
  view.setUint32(22, crc >>> 0, true);
  return page;
}
export function opusHead(channels: number, preSkip: number) {
  const head = new Uint8Array(19),
    view = new DataView(head.buffer);
  head.set(new TextEncoder().encode("OpusHead"));
  head[8] = 1;
  head[9] = channels;
  view.setUint16(10, preSkip, true);
  view.setUint32(12, 48000, true);
  return head;
}
export function opusTags(title: string, artist: string) {
  const encode = (value: string) => new TextEncoder().encode(value);
  const vendor = encode("MusicDownloader / libopus");
  const comments = [encode(`TITLE=${title}`), encode(`ARTIST=${artist}`)];
  const bytes = new Uint8Array(
    8 + 4 + vendor.length + 4 + comments.reduce((n, c) => n + 4 + c.length, 0),
  );
  bytes.set(encode("OpusTags"));
  const view = new DataView(bytes.buffer);
  let offset = 8;
  view.setUint32(offset, vendor.length, true);
  offset += 4;
  bytes.set(vendor, offset);
  offset += vendor.length;
  view.setUint32(offset, comments.length, true);
  offset += 4;
  for (const c of comments) {
    view.setUint32(offset, c.length, true);
    offset += 4;
    bytes.set(c, offset);
    offset += c.length;
  }
  return bytes;
}
