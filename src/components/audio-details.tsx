"use client";
import { useEffect, useRef, useState } from "react";
import type { Track } from "@/lib/model";
import { analyzeAudio } from "@/lib/audio";
import { fetchAudio, type AudioInput } from "@/lib/sources";
import {
  cutoffLabel,
  durationWarning,
  qualityLabel,
  sourceVerdict,
} from "@/lib/quality";
export default function AudioDetails({
  track,
  disabled,
  update,
}: {
  track: Track;
  disabled: boolean;
  update: (value: Partial<Track>) => void;
}) {
  const [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function measure() {
    const controller = new AbortController();
    abort.current = controller;
    setWorking(true);
    setError("");
    try {
      const source: AudioInput = track.output
        ? {
            blob: track.output,
            extension: track.outputName?.split(".").pop() || track.extension,
          }
        : await fetchAudio(track, controller.signal, () => {});
      const measurement = await analyzeAudio(
        source.blob,
        source.extension,
        controller.signal,
      );
      update({
        ...source.replacement,
        ...(source.quality ? { quality: source.quality } : {}),
        measurement,
        qualityWarning: durationWarning(track.duration, measurement.duration),
      });
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  const value = track.measurement;
  const metric = (n: number | undefined, unit: string) =>
    n === undefined
      ? "Not measured"
      : n === -Infinity
        ? "Silence"
        : `${n.toFixed(1)} ${unit}`;
  return (
    <details className="audio-details">
      <summary>
        {qualityLabel(track.quality) || "Audio details"}
        {track.replacement ? " · Replacement source" : ""}
        {value?.cutoffHz ? ` · Audio ends at ${cutoffLabel(value.cutoffHz)}` : ""}
      </summary>
      {track.quality?.format === "download" && (
        <p>Using the artist’s original file from SoundCloud.</p>
      )}
      {track.quality?.note && <p>{track.quality.note}</p>}
      {sourceVerdict(value) && <p>{sourceVerdict(value)}</p>}
      {value?.cutoffHz !== undefined &&
        value.cutoffHz < 18000 &&
        track.fallbackTicket && (
          <p>Another upload may reach higher. Compare them with Change source.</p>
        )}
      {value && (
        <dl>
          <dt>Measured file</dt>
          <dd>{qualityLabel(value)}</dd>
          <dt>Loudness</dt>
          <dd>{metric(value.integratedLufs, "LUFS")}</dd>
          <dt>True peak</dt>
          <dd>{metric(value.truePeakDbtp, "dBTP")}</dd>
          <dt>Sample peak</dt>
          <dd>{metric(value.samplePeakDbfs, "dBFS")}</dd>
          <dt>Loudness range</dt>
          <dd>{metric(value.loudnessRangeLu, "LU")}</dd>
          {value.spectrumMeasured && (
            <>
              <dt>Frequency range</dt>
              <dd>
                {value.cutoffHz
                  ? `Ends at ${cutoffLabel(value.cutoffHz)}`
                  : "No abrupt cutoff"}
              </dd>
            </>
          )}
          <dt>Duration</dt>
          <dd>{value.duration?.toFixed(2)} s</dd>
          {Boolean(value.attenuationDb) && (
            <>
              <dt>Headroom adjustment</dt>
              <dd>{metric(value.attenuationDb, "dB")}</dd>
            </>
          )}
        </dl>
      )}
      {value?.truePeakDbtp !== undefined && value.truePeakDbtp > 0 && (
        <p>
          Above full scale on reconstruction. Playback or conversion may clip.
        </p>
      )}
      {track.qualityWarning && <p>{track.qualityWarning}</p>}
      <button
        type="button"
        className="text-button"
        disabled={disabled || working}
        onClick={() => void measure()}
      >
        {working ? "Measuring…" : value ? "Measure again" : "Measure audio"}
      </button>
      {working && (
        <button
          type="button"
          className="text-button"
          onClick={() => abort.current?.abort()}
        >
          Cancel
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      <small>
        Measurements describe this file, not the original master. Peaks alone
        cannot establish whether the recording was already clipped.
      </small>
    </details>
  );
}
