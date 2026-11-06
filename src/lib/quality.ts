// Facts about the selected stream, kept separate from measured decoded audio.
export interface SourceQuality {
  codec?: string;
  bitrateKbps?: number;
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
  duration?: number;
  format?: string;
  note?: string;
  sourceUrl?: string;
}
export interface AudioMeasurement {
  codec?: string;
  bitrateKbps?: number;
  sampleRate?: number;
  channels?: number;
  duration?: number;
  integratedLufs?: number;
  loudnessRangeLu?: number;
  samplePeakDbfs?: number;
  truePeakDbtp?: number;
  attenuationDb?: number;
  // Where the source's audio stops abruptly; undefined when it doesn't.
  cutoffHz?: number;
  spectrumMeasured?: boolean;
  sourceCodec?: string;
}
export function parseMeasurement(log: string, bytes: number): AudioMeasurement {
  const duration = log.match(/Duration: (\d+):(\d+):([\d.]+)/);
  const seconds = duration
    ? +duration[1] * 3600 + +duration[2] * 60 + +duration[3]
    : undefined;
  // The output section describes FFmpeg's decoded PCM, not this file: Opus in
  // WebM lists no stream bitrate, which would otherwise report 1536 kb/s.
  const input = log.split(/Output #\d+/)[0];
  const stream = input.match(/Audio: ([\w]+)[^\n]*?, (\d+) Hz, ([^,\n]+)/);
  const last = (pattern: RegExp) => {
    const hits = [...log.matchAll(pattern)];
    const value = hits.at(-1)?.[1];
    return value === undefined
      ? undefined
      : value === "-inf"
        ? -Infinity
        : value === "inf"
          ? Infinity
          : Number(value);
  };
  return {
    codec: stream?.[1],
    sampleRate: stream ? +stream[2] : undefined,
    channels: stream?.[3].includes("stereo")
      ? 2
      : stream?.[3].includes("mono")
        ? 1
        : stream?.[3].includes("5.1")
          ? 6
          : stream?.[3].includes("7.1")
            ? 8
            : Number(stream?.[3].match(/(\d+) channels/)?.[1]) || undefined,
    duration: seconds,
    // Prefer the audio stream bitrate; otherwise an explicitly approximate
    // file average, which includes container overhead (especially for PCM).
    bitrateKbps: stream
      ? Number(input.match(/Audio: [^\n]*?, ([\d.]+) kb\/s/)?.[1]) ||
        (seconds ? (bytes * 8) / seconds / 1000 : undefined)
      : undefined,
    integratedLufs: last(/\bI:\s*(-?(?:[\d.]+|inf)) LUFS/g),
    loudnessRangeLu: last(/\bLRA:\s*([\d.]+) LU/g),
    truePeakDbtp: last(/Peak:\s*(-?(?:[\d.]+|inf)) dBFS/g),
    samplePeakDbfs: last(/Peak level dB:\s*(-?(?:[\d.]+|inf))/g),
  };
}
export function qualityLabel(value?: SourceQuality) {
  if (!value) return "";
  return [
    value.codec?.toUpperCase(),
    value.bitrateKbps ? `≈${Math.round(value.bitrateKbps)} kbps` : "",
    value.sampleRate ? `${value.sampleRate / 1000} kHz` : "",
    value.bitDepth ? `${value.bitDepth}-bit` : "",
    value.channels ? `${value.channels} ch` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
// Allow encoder overshoot to be corrected by another measured pass. Never
// boost quieter masters, normalize loudness, or claim to undo existing clipping.
export function headroomAdjustment(truePeak: number | undefined, target = -1) {
  return Number.isFinite(truePeak) ? Math.min(0, target - truePeak!) : 0;
}
export function durationWarning(expected?: number, actual?: number) {
  return expected &&
    actual &&
    Math.abs(expected - actual) > Math.max(3, expected * 0.03)
    ? `Length differs: expected ${Math.round(expected)}s, received ${Math.round(actual)}s. Check for a preview or another version.`
    : undefined;
}
// Lossy encoders discard everything above a fixed frequency: Opus at 20 kHz by
// design, low-bitrate AAC and MP3 around 16 kHz. Music rolls off gradually, so
// a sudden drop to near silence is the signature lossless checkers look for.
const FFT_SIZE = 4096;
const MAX_FRAMES = 600;
const BAND_HZ = 250;
const CUTOFF_DROP_DB = 30;
const QUIETEST_BAND_DB = -125;
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const angle = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size)
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(angle * k),
          wi = Math.sin(angle * k),
          a = start + k,
          b = a + size / 2,
          tr = re[b] * wr - im[b] * wi,
          ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
  }
}
// The frequency a mono signal stops at, judged on its louder half so a quiet
// intro or outro can't suggest a limit the music itself doesn't have.
export function spectralCutoff(
  samples: Float32Array,
  sampleRate: number,
): number | undefined {
  if (samples.length < FFT_SIZE) return undefined;
  const hann = Float64Array.from(
    { length: FFT_SIZE },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)),
  );
  const gain = hann.reduce((sum, value) => sum + value, 0) / 2;
  const hop = Math.max(
    FFT_SIZE,
    Math.floor((samples.length - FFT_SIZE) / MAX_FRAMES),
  );
  const bins = FFT_SIZE / 2;
  const frames: { energy: number; power: Float64Array }[] = [];
  const re = new Float64Array(FFT_SIZE),
    im = new Float64Array(FFT_SIZE);
  for (let at = 0; at + FFT_SIZE <= samples.length; at += hop) {
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[at + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    const power = new Float64Array(bins);
    let energy = 0;
    for (let i = 0; i < bins; i++) {
      power[i] = (re[i] * re[i] + im[i] * im[i]) / (gain * gain);
      energy += power[i];
    }
    frames.push({ energy, power });
  }
  frames.sort((a, b) => b.energy - a.energy);
  const loud = frames.slice(0, Math.max(1, Math.ceil(frames.length / 2)));
  const binHz = sampleRate / FFT_SIZE;
  const bandCount = Math.floor(sampleRate / 2 / BAND_HZ);
  const levels = Array.from({ length: bandCount }, (_, band) => {
    const from = Math.floor((band * BAND_HZ) / binHz),
      to = Math.max(from + 1, Math.floor(((band + 1) * BAND_HZ) / binHz));
    let sum = 0;
    for (const frame of loud)
      for (let i = from; i < Math.min(to, bins); i++) sum += frame.power[i];
    return 10 * Math.log10(sum / (loud.length * (to - from)) + 1e-30);
  });
  // A kilohertz of transition is allowed; all of the spectrum beyond it must
  // stay far below the kilohertz before it.
  const span = 1000 / BAND_HZ;
  for (let edge = 8000 / BAND_HZ; edge + span < bandCount; edge++) {
    const below =
      levels.slice(edge - span, edge).reduce((sum, value) => sum + value, 0) /
      span;
    if (below < QUIETEST_BAND_DB) continue;
    if (below - Math.max(...levels.slice(edge + span)) < CUTOFF_DROP_DB)
      continue;
    let top = edge - 1;
    while (top + 1 < bandCount && levels[top + 1] > below - 12) top++;
    return top * BAND_HZ;
  }
  return undefined;
}
const LOSSY_CODEC = /^(?:opus|vorbis|aac|mp4a|mp3|mp2|ac3|eac3|wma)/i;
export const cutoffLabel = (hz: number) =>
  `${Number((hz / 1000).toFixed(1))} kHz`;
// Plain language for what the measurement does and doesn't show.
export function sourceVerdict(value?: AudioMeasurement) {
  if (!value?.spectrumMeasured) return undefined;
  const lossy = value.sourceCodec && LOSSY_CODEC.test(value.sourceCodec);
  if (lossy)
    return value.cutoffHz
      ? `Lossy source (${value.sourceCodec}): audio ends at ${cutoffLabel(value.cutoffHz)}. FLAC keeps it from getting worse but can’t restore what’s missing, so lossless checkers will flag it.`
      : `Lossy source (${value.sourceCodec}). FLAC keeps it from getting worse but can’t restore what’s missing, so lossless checkers may flag it.`;
  if (value.cutoffHz)
    return `Audio stops abruptly at ${cutoffLabel(value.cutoffHz)}. This usually means it came from a lossy file, even in a lossless format.`;
  return "No lossy cutoff found. This supports a genuine lossless source but doesn’t prove one.";
}
