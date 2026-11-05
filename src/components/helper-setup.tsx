"use client";
import Accounts from "./accounts";
import { useEffect, useState } from "react";
import { Check, Download, LoaderCircle, X } from "lucide-react";
import {
  HELPER_RELEASE,
  HELPER_SOURCE,
  helperDownloads,
  helperConnection,
  helperFetch,
  disconnectHelper,
  helperOutdated,
  isLocalApp,
} from "@/lib/helper";

export default function HelperSetup({ onClose }: { onClose: () => void }) {
  const [platform, setPlatform] = useState<"windows" | "mac" | "linux">(
    "windows",
  );
  const [downloads, setDownloads] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState("");
  const [checking, setChecking] = useState(false);
  const [ready, setReady] = useState(false);
  const [local, setLocal] = useState(false);
  const [install, setInstall] = useState<{
    available?: boolean;
    installed?: boolean;
    current?: boolean;
  }>({});
  const [installing, setInstalling] = useState(false);
  useEffect(() => setLocal(isLocalApp()), []);
  useEffect(() => {
    if (!ready) return;
    helperFetch("/install")
      .then((response) => response.json())
      .then(setInstall)
      .catch(() => setInstall({}));
  }, [ready]);
  useEffect(() => {
    const name = navigator.userAgent.toLowerCase();
    setPlatform(
      /mac/.test(name) ? "mac" : /linux/.test(name) ? "linux" : "windows",
    );
  }, []);
  useEffect(() => {
    if (isLocalApp()) return;
    let active = true;
    const update = async () => {
      try {
        const response = await fetch("/api/helper-release");
        if (active) setDownloads(await response.json());
      } catch {}
    };
    void update();
    const timer = setInterval(update, 12000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const check = async () => {
    if (!helperConnection()) {
      setStatus(
        "Open the downloaded helper. It will connect this app automatically.",
      );
      return;
    }
    setChecking(true);
    setStatus("Connecting…");
    try {
      const response = await helperFetch("/health", {
        signal: AbortSignal.timeout(5000),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.detail || "Open the helper again to reconnect.");
      if (value.error) throw new Error(value.error);
      if (helperOutdated(value))
        throw new Error(
          "Your helper is out of date. Quit it, download the new one above, and open it.",
        );
      setReady(value.ready === true);
      setStatus(
        value.ready
          ? "Connected. Ready to download."
          : "Getting your helper ready…",
      );
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : "Open the helper and approve the browser connection.",
      );
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    const connected = () => {
      void check();
    };
    window.addEventListener("storage", connected);
    window.addEventListener("music-helper-connected", connected);
    if (helperConnection()) void check();
    const timer = setInterval(() => {
      if (helperConnection() && !ready) void check();
    }, 2500);
    return () => {
      clearInterval(timer);
      window.removeEventListener("storage", connected);
      window.removeEventListener("music-helper-connected", connected);
    };
  }, [ready]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="settings-modal helper-wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby="helper-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <span className="modal-icon">
            <Download size={21} />
          </span>
          <button
            className="icon-button"
            aria-label="Close helper setup"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <h2 id="helper-title">Connect your computer.</h2>
        <p className="modal-description">
          One small helper. No Python. No commands.
        </p>
        {!local && (
          <ol className="helper-steps">
            <li>
              <strong>Download</strong>
              <select
                aria-label="Helper operating system"
                value={platform}
                onChange={(event) =>
                  setPlatform(event.target.value as typeof platform)
                }
              >
                <option value="windows">Windows</option>
                <option value="mac">Mac</option>
                <option value="linux">Linux</option>
              </select>
              <a
                className="primary-button"
                aria-disabled={!downloads[platform]}
                onClick={(event) => {
                  if (!downloads[platform]) event.preventDefault();
                }}
                href={
                  downloads[platform] ? helperDownloads[platform] : undefined
                }
              >
                <Download size={16} />
                {downloads[platform]
                  ? "Download helper"
                  : "Preparing download…"}
              </a>
              <small className="helper-source">
                From{" "}
                <a href={HELPER_RELEASE} target="_blank" rel="noreferrer">
                  GitHub Releases
                </a>
                , built by GitHub Actions from this{" "}
                <a href={HELPER_SOURCE} target="_blank" rel="noreferrer">
                  open-source repository
                </a>
                .
              </small>
            </li>
            <li>
              <strong>Open the download</strong>
              <p>
                {platform === "mac"
                  ? "Unzip and open MusicDownloader Helper."
                  : platform === "linux"
                    ? "Extract and open MusicDownloader-Helper."
                    : "Open it. It runs right away, and can add itself to your Start menu."}{" "}
                Keep it running while you download.
              </p>
              <small>
                {platform === "windows"
                  ? "If Windows warns: More info → Run anyway."
                  : platform === "mac"
                    ? "If blocked: System Settings → Privacy & Security → Open Anyway."
                    : "Your system may ask you to allow this unsigned helper."}
              </small>
            </li>
            <li>
              <strong>Allow the browser connection</strong>
              <p>
                The helper opens its own copy of this app, running entirely on
                your computer, and pairs automatically.
              </p>
            </li>
          </ol>
        )}
        {status && (
          <p className="helper-status" role="status">
            {checking ? (
              <LoaderCircle className="spin" size={15} />
            ) : ready ? (
              <Check size={15} />
            ) : null}
            {status}
          </p>
        )}
        <button
          className="primary-button full-width"
          onClick={ready ? onClose : check}
          disabled={checking}
        >
          {ready ? "Done" : "Check connection"}
          {checking ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <Check size={15} />
          )}
        </button>
        {ready && install.available && !install.current && (
          <button
            className="secondary-button full-width"
            disabled={installing}
            onClick={async () => {
              setInstalling(true);
              try {
                const response = await helperFetch("/install", {
                  method: "POST",
                });
                const value = await response.json();
                if (!response.ok) throw new Error(value.detail);
                setInstall(value);
                setStatus(
                  "Installed. Open MusicDownloader Helper from your Start menu next time.",
                );
              } catch (error) {
                setStatus(
                  error instanceof Error
                    ? error.message
                    : "Could not install the helper.",
                );
              } finally {
                setInstalling(false);
              }
            }}
          >
            {install.installed
              ? "Update the installed helper with this one"
              : "Add to Start menu"}
          </button>
        )}
        {ready && <Accounts />}
        <button
          className="text-button"
          onClick={async () => {
            try {
              await helperFetch("/quit", { method: "POST" });
            } finally {
              disconnectHelper();
              setReady(false);
              setStatus("Helper closed.");
            }
          }}
          disabled={!helperConnection()}
        >
          Quit helper
        </button>
        <p className="settings-note">
          YouTube, SoundCloud, Bandcamp, and Spotify matching use your
          connection. Conversion and ZIPs stay in this browser.
        </p>
      </section>
    </div>
  );
}
