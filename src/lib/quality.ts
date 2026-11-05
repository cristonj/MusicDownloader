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
