"use client";
import { useEffect, useState } from "react";
import { Check, ExternalLink, LoaderCircle, Sparkles, X } from "lucide-react";
import { helperConnection, helperFetch } from "@/lib/helper";
import ExtensionSetup from "./extension-setup";
export type Service = "youtube" | "soundcloud";
export type Accounts = Partial<Record<Service, string>>;
const SERVICES: {
  id: Service;
  name: string;
  signIn: string;
  plan: string;
}[] = [
  {
    id: "youtube",
    name: "YouTube Music",
    signIn: "https://music.youtube.com/",
    plan: "Music Premium can unlock higher-bitrate audio on some tracks.",
  },
  {
    id: "soundcloud",
    name: "SoundCloud",
    signIn: "https://soundcloud.com/signin",
    plan: "Go+ can unlock higher-quality audio on some tracks.",
  },
];
const BROWSERS = [
  ["firefox", "Firefox (most reliable)"],
  ["chrome", "Chrome"],
  ["edge", "Edge"],
  ["brave", "Brave"],
  ["chromium", "Chromium"],
  ["safari", "Safari"],
];
export async function readAccounts(): Promise<Accounts> {
  if (!helperConnection()) return {};
  const response = await helperFetch("/accounts");
  return response.ok ? (await response.json()).accounts || {} : {};
}
type Result = { kind: "good" | "warn" | "bad"; text: string };
export default function BetterAudio({
  onClose,
  openHelper,
}: {
  onClose: () => void;
  openHelper: () => void;
}) {
  const connected = Boolean(helperConnection());
  const [accounts, setAccounts] = useState<Accounts>({});
  const [browser, setBrowser] = useState("firefox");
  const [working, setWorking] = useState<Service | null>(null);
  const [results, setResults] = useState<Partial<Record<Service, Result>>>({});
  useEffect(() => {
    readAccounts()
      .then(setAccounts)
      .catch(() => {});
  }, []);
  const save = async (next: Accounts) => {
    const response = await helperFetch("/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    if (!response.ok) throw new Error("Update the helper to connect accounts.");
    const saved = (await response.json()).accounts as Accounts;
    setAccounts(saved);
    return saved;
  };
  const connect = async (service: Service) => {
    setWorking(service);
    setResults((items) => ({ ...items, [service]: undefined }));
    const previous = accounts;
    try {
      await save({ ...accounts, [service]: browser });
      const response = await helperFetch("/accounts/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service }),
      });
      const check = await response.json();
      if (!response.ok) {
        // A session that can't be read would break every later download.
        await save(previous);
        throw new Error(check.detail || "This browser could not be read.");
      }
      setResults((items) => ({
        ...items,
        [service]: check.signedIn
          ? { kind: "good", text: "Connected and signed in." }
          : {
              kind: "warn",
              text: "Connected, but your sign-in couldn't be confirmed. Make sure you signed in using this browser.",
            },
      }));
    } catch (error) {
      setResults((items) => ({
        ...items,
        [service]: { kind: "bad", text: (error as Error).message },
      }));
    } finally {
      setWorking(null);
    }
  };
  const disconnect = async (service: Service) => {
    const next = { ...accounts };
    delete next[service];
    await save(next).catch(() => {});
    setResults((items) => ({ ...items, [service]: undefined }));
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="settings-modal better-audio"
        role="dialog"
        aria-modal="true"
        aria-labelledby="better-audio-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <span className="modal-icon">
            <Sparkles size={21} />
          </span>
          <button
            className="icon-button"
            aria-label="Close sign-in"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <h2 id="better-audio-title">Sign in for better audio</h2>
        <p className="modal-description">
          You sign in on the service&apos;s own website, never here. The helper
          then uses that browser&apos;s session on your computer.
        </p>
        <ExtensionSetup onAccountsChanged={() => { void readAccounts().then(setAccounts).catch(() => {}); }} />
        <h3>Or connect without the extension</h3>
        <ol className="better-steps">
          <li className={connected ? "step-done" : ""}>
            <strong>Connect the desktop helper</strong>
            {connected ? (
              <p>
                <Check size={14} /> Connected.
              </p>
            ) : (
              <>
                <p>Sign-in only works through the helper.</p>
                <button className="primary-button" onClick={openHelper}>
                  Set up the helper
                </button>
              </>
            )}
          </li>
          <li>
            <strong>Choose the browser you&apos;ll sign in with</strong>
            <select
              aria-label="Account browser"
              value={browser}
              disabled={!connected}
              onChange={(event) => setBrowser(event.target.value)}
            >
              {BROWSERS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <small>
              It must be installed and using its default profile. Chrome and
              Edge often block access to their sessions.
            </small>
          </li>
          <li>
            <strong>Sign in, then connect</strong>
            <p>Do this for each service you pay for.</p>
            {SERVICES.map((service) => {
              const result = results[service.id];
              const linked = accounts[service.id];
              return (
                <div className="better-service" key={service.id}>
                  <div>
                    <b>{service.name}</b>
                    <small>{service.plan}</small>
                    {linked && !result && (
                      <small className="better-good">
                        <Check size={12} /> Connected through {linked === "extension" ? "the browser extension" : linked}
                      </small>
                    )}
                    {result && (
                      <small
                        className={`better-${result.kind}`}
                        role={result.kind === "bad" ? "alert" : "status"}
                      >
                        {result.text}
                      </small>
                    )}
                  </div>
                  <div className="better-actions">
                    <a
                      className="secondary-button"
                      href={service.signIn}
                      target="_blank"
                      rel="noreferrer"
                    >
                      1. Sign in <ExternalLink size={12} />
                    </a>
                    <button
                      className="primary-button"
                      disabled={!connected || working !== null}
                      aria-label={`Connect ${service.name}`}
                      onClick={() => void connect(service.id)}
                    >
                      {working === service.id ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : null}
                      2. Connect
                    </button>
                    {linked && (
                      <button
                        className="text-button"
                        aria-label={`Disconnect ${service.name}`}
                        onClick={() => void disconnect(service.id)}
                      >
                        Disconnect
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </li>
        </ol>
        <p className="settings-note">
          The link opens in your default browser. If that isn&apos;t the one you
          chose above, sign in there instead. If connecting fails, close that
          browser and try again. Tracks already marked Ready keep their file, so
          remove and re-add them to use the better audio.
        </p>
        <p className="settings-note">
          A free account doesn&apos;t improve quality, and a paid one only helps
          when the track offers more. Cookies stay on your computer. Spotify,
          Apple Music, and Amazon Music have no sign-in here because their audio
          is protected, so those tracks use matched uploads.
        </p>
        <button className="primary-button full-width" onClick={onClose}>
          Done <Check size={16} />
        </button>
      </section>
    </div>
  );
}
