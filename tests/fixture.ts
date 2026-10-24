export function demoFile(): File {
  const rate = 44100,
    length = rate * 5;
  const data = new ArrayBuffer(44 + length * 2);
  const view = new DataView(data);
  const text = (offset: number, s: string) =>
    [...s].forEach((char, index) =>
      view.setUint8(offset + index, char.charCodeAt(0)),
    );
  text(0, "RIFF");
  view.setUint32(4, data.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    const fade = Math.min(1, t * 2, (5 - t) * 1.5);
    const chord = [220, 261.63, 329.63, 440].reduce(
      (sum, hz, index) =>
        sum +
        Math.sin(2 * Math.PI * hz * t) *
          (0.09 + 0.02 * Math.sin(t * (index + 1))),
      0,
    );
    view.setInt16(44 + i * 2, chord * fade * 32767, true);
  }
  return new File([data], "Sunday morning.wav", { type: "audio/wav" });
}
