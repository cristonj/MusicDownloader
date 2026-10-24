"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  AudioLines,
  Check,
  ChevronDown,
  CircleHelp,
  Clipboard,
  Download,
  ExternalLink,
  FileAudio,
  FolderDown,
  Link2,
  LoaderCircle,
  Pause,
  Play,
  Settings2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  bytesLabel,
  durationLabel,
  formats,
  isLossless,
  type Provider,
  type Track,
} from "@/lib/model";
import { useLibrary } from "./use-library";

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`}>
      <span className="brand-mark">
        <AudioLines size={23} />
        <ArrowDown size={12} />
      </span>
      <span>
        music<span className="brand-light">downloader</span>
        <span className="brand-dot">.</span>
      </span>
    </div>
  );
}
function ServiceIcon({
  provider,
  size = 16,
}: {
  provider: Provider;
  size?: number;
}) {
  if (provider === "YouTube")
    return (
      <svg
        width={size + 3}
        height={size}
        viewBox="0 0 24 18"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M23.5 3A3 3 0 0 0 21.4.8C19.5.3 12 .3 12 .3S4.5.3 2.6.8A3 3 0 0 0 .5 3C0 5 0 9 0 9s0 4 .5 6a3 3 0 0 0 2.1 2.2c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.2c.5-2 .5-6 .5-6s0-4-.5-6ZM9.6 12.8V5.2L15.8 9Z" />
      </svg>
    );
  if (provider === "Spotify")
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="11" fill="currentColor" />
        <path
          d="M6 9c4-1 9-.5 12 1M7 12.5c3.5-1 7-.5 10 .8M8 16c3-.7 5.5-.3 8 .6"
          stroke="var(--surface)"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  if (provider === "SoundCloud") return <AudioLines size={size} />;
  if (provider === "Bandcamp")
    return (
      <svg
        width={size + 2}
        height={size}
        viewBox="0 0 24 18"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M7 2h17l-7 14H0Z" />
      </svg>
    );
  return <FileAudio size={size} />;
}
const providers: Provider[] = ["YouTube", "Spotify", "SoundCloud", "Bandcamp"];
const placeholders: Record<string, string> = {
  YouTube: "Paste a YouTube song or playlist link",
  Spotify: "Paste a Spotify song, album, or playlist link",
  SoundCloud: "Paste a SoundCloud track or set link",
  Bandcamp: "Paste a Bandcamp track or album link",
};

export default function Downloader() {
  const library = useLibrary();
  const { tracks, prefs, busy, resolving, notice } = library;
  const [input, setInput] = useState("");
  const [activeProvider, setActiveProvider] = useState<Provider | null>(null);
  const [dragging, setDragging] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioUrl = useRef<string | null>(null);
  const dragDepth = useRef(0);
  const selected = tracks.filter((t) => t.selected);
  const locked = busy || resolving || !library.hydrated;
  const formatLabel = formats.find((f) => f.value === prefs.format)?.label;
  const finished = tracks.filter((t) => t.status === "done").length;
  const formatQuality =
    prefs.format === "original"
      ? "Source quality"
      : isLossless(prefs.format)
        ? `${prefs.bitDepth}-bit`
        : `${prefs.bitrate} kbps`;

  const stopAudio = () => {
    audio.current?.pause();
    audio.current = null;
    if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
    audioUrl.current = null;
    setPlayingId(null);
  };
  useEffect(
    () => () => {
      audio.current?.pause();
      if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
    },
    [],
  );
  useEffect(() => {
    if (playingId && !tracks.some((t) => t.id === playingId)) stopAudio();
  }, [tracks, playingId]);
  useEffect(() => {
    if (!library.settingsOpen && !helpOpen) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        library.setSettingsOpen(false);
        setHelpOpen(false);
      }
      if (event.key === "Tab") {
        const dialog = document.querySelector('[role="dialog"]');
        const targets = Array.from(
          dialog?.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]",
          ) || [],
        );
        const first = targets[0],
          last = targets[targets.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('[role="dialog"] button')?.focus(),
    );
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("keydown", keydown);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [library.settingsOpen, helpOpen]);

  const preview = async (track: Track) => {
    if (playingId === track.id) {
      stopAudio();
      return;
    }
    stopAudio();
    const blob = track.output || track.file;
    const source = blob ? URL.createObjectURL(blob) : track.mediaUrl;
    if (!source) return;
    if (blob) audioUrl.current = source;
    const player = new Audio(source);
    audio.current = player;
    player.onended = stopAudio;
    player.onerror = () => {
      stopAudio();
      library.notify(
        "Your browser cannot preview this format. You can still export it.",
        "error",
      );
    };
    try {
      await player.play();
      setPlayingId(track.id);
    } catch {
      stopAudio();
      library.notify(
        "Preview unavailable. Try downloading this track.",
        "error",
      );
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await library.addLink(input)) setInput("");
  };
  const paste = async () => {
    try {
      setInput(await navigator.clipboard.readText());
      linkInput.current?.focus();
    } catch {
      library.notify("Paste a link into the field with Ctrl+V or ⌘V.");
      linkInput.current?.focus();
    }
  };

  return (
    <div
      className="app-shell"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepth.current--;
        if (dragDepth.current <= 0) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (!locked) library.addFiles(event.dataTransfer.files);
      }}
    >
      <div className="main-shell minimal-shell">
        <header className="topbar">
          <Brand compact />
          <div className="topbar-right">
            <button
              className="icon-button"
              aria-label="Help"
              onClick={() => setHelpOpen(true)}
            >
              <CircleHelp size={18} />
            </button>
            <button
              className="icon-button"
              aria-label="Preferences"
              onClick={() => library.setSettingsOpen(true)}
            >
              <Settings2 size={19} />
            </button>
          </div>
        </header>
        <main>
          <section className="import-card" aria-label="Import music">
            <form onSubmit={submit}>
              <div className="link-field">
                <Link2 size={20} className="input-link-icon" />
                <input
                  ref={linkInput}
                  aria-label="Music or playlist link"
                  placeholder={
                    activeProvider
                      ? placeholders[activeProvider]
                      : "Paste a song or playlist link…"
                  }
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  disabled={locked}
                  autoComplete="off"
                  type="text"
                  inputMode="url"
                />
                <button
                  type="button"
                  className="paste-button"
                  onClick={paste}
                  disabled={locked}
                  aria-label="Paste from clipboard"
                >
                  <Clipboard size={15} />
                  <span>Paste</span>
                </button>
                <button
                  type="submit"
                  className="add-button"
                  disabled={!input.trim() || locked}
                  aria-label="Add music link"
                >
                  {resolving ? (
                    <LoaderCircle size={20} className="spin" />
                  ) : (
                    <ArrowRight size={21} />
                  )}
                </button>
              </div>
            </form>
            <div className="services">
              <div className="service-list">
                {providers.map((provider) => (
                  <button
                    key={provider}
                    className={`service-chip ${activeProvider === provider ? "chosen" : ""}`}
                    onClick={() => {
                      setActiveProvider(
                        activeProvider === provider ? null : provider,
                      );
                      linkInput.current?.focus();
                    }}
                    aria-pressed={activeProvider === provider}
                  >
                    <ServiceIcon provider={provider} />
                    {provider}
                  </button>
                ))}
              </div>
            </div>
            <div className="import-divider" />
            <div className="file-import">
              <div className="file-import-icon">
                <Upload size={20} />
              </div>
              <div>
                <strong>or drop audio files</strong>
              </div>
              <button
                className="secondary-button"
                onClick={() => files.current?.click()}
                disabled={locked}
              >
                Browse files
              </button>
            </div>
            <input
              ref={files}
              type="file"
              multiple
              accept="audio/*,.mp3,.wav,.flac,.m4a,.aac,.ogg,.opus,.aif,.aiff,.webm,.mp4"
              hidden
              onChange={(event) => {
                if (event.target.files) library.addFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </section>

          <section className="format-bar" aria-label="Export settings">
            <div className="format-controls">
              <label className="select-wrap">
                <span>Format</span>
                <select
                  aria-label="Output format"
                  value={prefs.format}
                  onChange={(event) =>
                    library.changePrefs({
                      format: event.target.value as typeof prefs.format,
                    })
                  }
                  disabled={locked}
                >
                  {formats.map((format) => (
                    <option value={format.value} key={format.value}>
                      {format.label}
                    </option>
                  ))}
                </select>
                <ChevronDown size={13} />
              </label>
              <span className="control-divider" />
              <label className="select-wrap quality-select">
                <span>Quality</span>
                {prefs.format === "original" ? (
                  <strong>Source quality</strong>
                ) : isLossless(prefs.format) ? (
                  <select
                    aria-label="Bit depth"
                    value={prefs.bitDepth}
                    onChange={(event) =>
                      library.changePrefs({
                        bitDepth: event.target.value as typeof prefs.bitDepth,
                      })
                    }
                    disabled={locked}
                  >
                    <option value="16">16-bit</option>
                    <option value="24">24-bit</option>
                  </select>
                ) : (
                  <select
                    aria-label="Audio bitrate"
                    value={prefs.bitrate}
                    onChange={(event) =>
                      library.changePrefs({
                        bitrate: event.target.value as typeof prefs.bitrate,
                      })
                    }
                    disabled={locked}
                  >
                    {["128", "192", "256", "320"].map((value) => (
                      <option key={value} value={value}>
                        {value} kbps
                      </option>
                    ))}
                  </select>
                )}
                {prefs.format !== "original" && <ChevronDown size={13} />}
              </label>
              <button
                className="icon-button advanced-settings"
                aria-label="Advanced audio settings"
                onClick={() => library.setSettingsOpen(true)}
              >
                <Settings2 size={17} />
              </button>
            </div>
          </section>

          {notice && (
            <div
              className={`notice ${notice.kind}`}
              role={notice.kind === "error" ? "alert" : "status"}
            >
              <span>
                {notice.kind === "success" ? (
                  <Check size={17} />
                ) : (
                  <CircleHelp size={17} />
                )}
              </span>
              <p>{notice.text}</p>
              <button
                className="icon-button"
                onClick={() => library.setNotice(null)}
                aria-label="Dismiss message"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {resolving && (
            <div className="operation-status" role="status">
              <LoaderCircle size={16} className="spin" />
              <span>Finding your music & matching sources…</span>
              <button onClick={library.cancel}>Cancel</button>
            </div>
          )}

          {tracks.length > 0 && (
            <section
              className="collection"
              id="collection"
              aria-label="Music collection"
            >
              <div className="collection-header">
                <h2>
                  Tracks{" "}
                  <span>{tracks.length.toString().padStart(2, "0")}</span>
                </h2>
                {tracks.length > 0 ? (
                  <button
                    className="text-button"
                    onClick={() => {
                      stopAudio();
                      library.clear();
                    }}
                    disabled={locked}
                  >
                    <Trash2 size={14} /> Clear all
                  </button>
                ) : null}
              </div>
              <>
                <div className="track-list-heading">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={
                        tracks.filter((t) => t.file || t.mediaUrl).length > 0 &&
                        tracks
                          .filter((t) => t.file || t.mediaUrl)
                          .every((t) => t.selected)
                      }
                      onChange={library.selectAll}
                      disabled={locked}
                      aria-label="Select all tracks"
                    />
                    <span>{selected.length} selected</span>
                  </label>
                  <span>TIME</span>
                </div>
                <div className="track-list">
                  {tracks.map((track, index) => (
                    <div
                      className={`track-row ${track.status === "error" ? "track-error" : ""}`}
                      key={track.id}
                    >
                      <input
                        type="checkbox"
                        checked={track.selected}
                        onChange={() => library.select(track.id)}
                        disabled={locked || (!track.file && !track.mediaUrl)}
                        aria-label={`Select ${track.title}`}
                      />
                      <button
                        className={`track-art art-${index % 4} ${playingId === track.id ? "is-playing" : ""}`}
                        onClick={() => preview(track)}
                        disabled={!track.file && !track.output}
                        aria-label={`${playingId === track.id ? "Pause" : "Preview"} ${track.title}`}
                      >
                        {playingId === track.id ? (
                          <Pause size={17} fill="currentColor" />
                        ) : (
                          <Play size={17} fill="currentColor" />
                        )}
                      </button>
                      <div className="track-info">
                        <strong title={track.title}>{track.title}</strong>
                        <div className="track-subtitle">
                          <ServiceIcon provider={track.provider} size={11} />
                          <span>{track.artist || track.provider}</span>
                          {track.file && (
                            <>
                              <i>·</i>
                              <span>{bytesLabel(track.file.size)}</span>
                            </>
                          )}
                        </div>
                        {track.matchedTitle && (
                          <a
                            className="match-source"
                            href={track.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            YouTube match: {track.matchedTitle}{" "}
                            <ExternalLink size={10} />
                          </a>
                        )}
                        {track.error && (
                          <span className="track-error-message">
                            {track.error}
                          </span>
                        )}
                        {["fetching", "converting"].includes(track.status) && (
                          <div className="track-progress">
                            <span
                              style={{ width: `${track.progress * 100}%` }}
                            />
                          </div>
                        )}
                      </div>
                      <div className="track-state">
                        {track.status === "done" ? (
                          <span className="done-label">
                            <Check size={12} /> Ready
                          </span>
                        ) : ["fetching", "converting"].includes(
                            track.status,
                          ) ? (
                          <LoaderCircle size={15} className="spin" />
                        ) : (
                          <span>{track.extension.toUpperCase()}</span>
                        )}
                      </div>
                      <span className="track-duration">
                        {durationLabel(track.duration)}
                      </span>
                      <button
                        className="icon-button track-download"
                        disabled={locked || (!track.file && !track.mediaUrl)}
                        onClick={() => library.download([track.id], false)}
                        aria-label={`Download ${track.title}`}
                      >
                        <Download size={17} />
                      </button>
                      <button
                        className="icon-button remove-track"
                        disabled={locked}
                        onClick={() => library.remove(track.id)}
                        aria-label={`Remove ${track.title}`}
                      >
                        <X size={15} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="export-bar">
                  <div className="export-summary">
                    <FolderDown size={20} />
                    <div>
                      <strong>
                        {selected.length} track
                        {selected.length === 1 ? "" : "s"}
                      </strong>
                      <span>
                        {formatLabel} <i>·</i> {formatQuality}
                      </span>
                    </div>
                  </div>
                  {busy ? (
                    <button
                      className="primary-button cancel-button"
                      onClick={library.cancel}
                    >
                      <X size={16} /> Cancel export
                    </button>
                  ) : (
                    <button
                      className="primary-button"
                      disabled={!selected.length || resolving}
                      onClick={() =>
                        library.download(
                          selected.map((t) => t.id),
                          selected.length > 1,
                        )
                      }
                    >
                      <ArrowDownToLine size={17} />
                      {selected.length > 1 ? "Download ZIP" : "Download track"}
                    </button>
                  )}
                </div>
                {busy && (
                  <div className="operation-status export-status" role="status">
                    <LoaderCircle size={15} className="spin" />
                    <span>{library.status}</span>
                  </div>
                )}
              </>
            </section>
          )}
        </main>
      </div>

      {dragging && (
        <div className="drop-overlay">
          <div>
            <Upload size={45} />
            <h2>Drop audio files</h2>
            <p>
              {locked
                ? "Wait for the current operation to finish."
                : "Your files stay on your device."}
            </p>
          </div>
        </div>
      )}
      {(library.settingsOpen || helpOpen) && (
        <div
          className="modal-backdrop"
          onClick={() => {
            library.setSettingsOpen(false);
            setHelpOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            className="settings-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <span className="modal-icon">
                {helpOpen ? <CircleHelp size={21} /> : <Settings2 size={21} />}
              </span>
              <button
                className="icon-button"
                aria-label="Close dialog"
                onClick={() => {
                  library.setSettingsOpen(false);
                  setHelpOpen(false);
                }}
              >
                <X size={20} />
              </button>
            </div>
            {helpOpen ? (
              <>
                <h2 id="dialog-title">How it works</h2>
                <div className="help-steps">
                  <div>
                    <span>01</span>
                    <section>
                      <strong>Add your music</strong>
                      <p>
                        Import audio files, a direct audio URL, or a song,
                        album, or playlist link.
                      </p>
                    </section>
                  </div>
                  <div>
                    <span>02</span>
                    <section>
                      <strong>Choose your format</strong>
                      <p>
                        Original is fastest. MP3, AAC, FLAC, WAV, OGG, Opus, and
                        AIFF convert on your device. A higher setting cannot
                        restore detail missing from the source.
                      </p>
                    </section>
                  </div>
                  <div>
                    <span>03</span>
                    <section>
                      <strong>Keep a song. Or the whole set.</strong>
                      <p>
                        Download a track or select several for a ZIP. Up to 100
                        tracks, 150 MB per track, and 450 MB per collection.
                      </p>
                    </section>
                  </div>
                </div>
                <div className="help-detail">
                  <strong>About service links</strong>
                  <p>
                    Links open automatically. Spotify supplies the track list;
                    audio comes from the YouTube matches you select. Bandcamp
                    purchases and private or restricted tracks need your
                    original files.
                  </p>
                </div>
                <button
                  className="primary-button full-width"
                  onClick={() => {
                    setHelpOpen(false);
                  }}
                >
                  Done <Check size={16} />
                </button>
              </>
            ) : (
              <>
                <h2 id="dialog-title">Preferences</h2>
                <p className="modal-description">
                  Saved in this browser. No account needed.
                </p>
                <div className="settings-section">
                  <h3>Audio</h3>
                  <label className="settings-row">
                    <span>
                      Sample rate
                      <small>Source preserves the original rate.</small>
                    </span>
                    <select
                      aria-label="Sample rate"
                      value={prefs.sampleRate}
                      disabled={
                        locked ||
                        prefs.format === "original" ||
                        prefs.format === "opus"
                      }
                      onChange={(event) =>
                        library.changePrefs({
                          sampleRate: event.target
                            .value as typeof prefs.sampleRate,
                        })
                      }
                    >
                      <option value="source">Source</option>
                      <option value="44100">44.1 kHz</option>
                      <option value="48000">48 kHz</option>
                      <option value="96000">96 kHz</option>
                    </select>
                  </label>
                  <p className="settings-note">
                    Converting to lossless or increasing quality does not
                    restore missing detail. Original keeps the source untouched.
                  </p>
                </div>
                <button
                  className="primary-button full-width"
                  onClick={() => library.setSettingsOpen(false)}
                >
                  Done <Check size={16} />
                </button>
              </>
            )}
          </section>
        </div>
      )}
      <div className="sr-only" aria-live="polite">
        {finished} tracks ready for download.
      </div>
    </div>
  );
}
