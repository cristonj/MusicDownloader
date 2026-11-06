"use client";
import { useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import { providerFor, parseUrl, type Track } from "@/lib/model";
import { analyzeSample } from "@/lib/audio";
import { cutoffLabel, qualityLabel } from "@/lib/quality";
import {
  loadSourceChoices,
  sampleAudio,
  type SourceChoice,
} from "@/lib/sources";
type Range = "measuring" | "failed" | { cutoffHz?: number };
const NO_CUTOFF = Number.POSITIVE_INFINITY;
// The upload a track downloads from, and the others it could use instead.
export default function SourcePicker({
  track,
  disabled,
  update,
}: {
  track: Track;
  disabled: boolean;
  update: (value: Partial<Track>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<SourceChoice[] | null>(null);
  const [error, setError] = useState("");
  const [ranges, setRanges] = useState<Record<string, Range>>({});
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  if (!track.fallbackTicket) return null;
  const load = async () => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setChoices(null);
    setError("");
    try {
      const found = await loadSourceChoices(track, controller.signal);
      if (controller.signal.aborted) return;
      setChoices(found);
      setRanges(
        Object.fromEntries(found.map((x) => [x.sourceUrl, "measuring" as const])),
      );
      // One at a time: each is a short download and a decode on this device.
      for (const choice of found) {
        if (controller.signal.aborted) return;
        let range: Range = "failed";
        try {
          const sample = await sampleAudio(
            choice.mediaUrl,
            track.transport,
            controller.signal,
          );
          const result = await analyzeSample(
            sample.blob,
            sample.extension,
            controller.signal,
          );
          if (result.measured) range = { cutoffHz: result.cutoffHz };
        } catch {
          if (controller.signal.aborted) return;
        }
        setRanges((value) => ({ ...value, [choice.sourceUrl]: range }));
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError((reason as Error).message);
    }
  };
  const toggle = () => {
    if (open) abort.current?.abort();
    else if (!choices) void load();
    setOpen(!open);
  };
  const pick = (choice: SourceChoice) => {
    update({
      mediaUrl: choice.mediaUrl,
      sourceUrl: choice.sourceUrl,
      extension: choice.extension,
      matchedTitle: choice.title,
      matchedChannel: choice.channel,
      matchReason: choice.reason,
      matchConfidence: choice.confidence,
      quality: choice.quality,
      originalDownload: choice.originalDownload,
      artistLink: choice.artistLink,
      replacement: undefined,
      output: undefined,
      outputName: undefined,
      measurement: undefined,
      qualityWarning: undefined,
      status: "ready",
      progress: 0,
      error: undefined,
      selected: true,
    });
    setOpen(false);
  };
  const current = track.sourceUrl
    ? providerFor(parseUrl(track.sourceUrl))
    : "None";
  const richest = Math.max(
    0,
    ...(choices || []).map((choice) => choice.quality.bitrateKbps || 0),
  );
  const reach = (range?: Range) =>
    range && typeof range === "object" ? (range.cutoffHz ?? NO_CUTOFF) : 0;
  const measuredAll = (choices || []).every(
    (choice) => ranges[choice.sourceUrl] !== "measuring",
  );
  const widest = Math.max(
    0,
    ...(choices || []).map((choice) => reach(ranges[choice.sourceUrl])),
  );
  const differ = (choices || []).some(
    (choice) =>
      reach(ranges[choice.sourceUrl]) > 0 &&
      reach(ranges[choice.sourceUrl]) !== widest,
  );
  const rangeLabel = (range?: Range) =>
    range === "measuring"
      ? "Measuring range…"
      : range === "failed" || !range
        ? "Range not measured"
        : range.cutoffHz
          ? `Audio ends at ${cutoffLabel(range.cutoffHz)}`
          : "No abrupt cutoff";
  return (
    <div className="source-picker">
      <button
        type="button"
        className="source-toggle"
        disabled={disabled}
        aria-expanded={open}
        aria-label={`Change source for ${track.title}`}
        onClick={toggle}
      >
        <RefreshCw size={11} /> Source: {current} · Change source
      </button>
      {open && (
        <div className="source-options">
          {!choices && !error && (
            <p className="source-state" role="status">
              <LoaderCircle size={13} className="spin" /> Comparing YouTube and
              SoundCloud…
            </p>
          )}
          {error && (
            <p className="source-state" role="alert">
              {error}{" "}
              <button type="button" onClick={() => void load()}>
                Try again
              </button>
            </p>
          )}
          {choices?.length === 0 && (
            <p className="source-state">No other uploads of this track found.</p>
          )}
          {choices?.map((choice) => {
            const chosen = choice.sourceUrl === track.sourceUrl;
            return (
              <div
                className={`source-option ${chosen ? "chosen" : ""}`}
                key={choice.sourceUrl}
              >
                <div className="source-option-text">
                  <strong title={choice.title}>{choice.title}</strong>
                  <span>
                    {choice.provider}
                    {choice.channel && ` · ${choice.channel}`}
                    {choice.confidence !== undefined &&
                      ` · ${Math.round(choice.confidence * 100)}% match`}
                  </span>
                  <span className="source-quality">
                    {qualityLabel(choice.quality) || "Quality not listed"}
                    {richest > 0 &&
                      choice.quality.bitrateKbps === richest &&
                      " · Highest bitrate here"}
                  </span>
                  <span className="source-quality">
                    {rangeLabel(ranges[choice.sourceUrl])}
                    {measuredAll &&
                      differ &&
                      reach(ranges[choice.sourceUrl]) === widest &&
                      " · Widest range here"}
                    {choice.originalDownload && " · Artist’s original available"}
                  </span>
                  {choice.artistLink && (
                    <a
                      href={choice.artistLink.url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Artist: {choice.artistLink.label}
                    </a>
                  )}
                </div>
                <a
                  href={choice.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open ${choice.title} on ${choice.provider}`}
                >
                  <ExternalLink size={13} />
                </a>
                <button
                  type="button"
                  disabled={disabled || chosen}
                  onClick={() => pick(choice)}
                >
                  {chosen ? "In use" : "Use"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
