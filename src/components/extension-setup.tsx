"use client";
import { useEffect, useState } from "react";
import { helperConnection, helperFetch } from "@/lib/helper";

type Status = { available?: boolean; paired: boolean; services: Record<string, { updated: number; expires: number }> };
export default function ExtensionSetup({ onAccountsChanged }: { onAccountsChanged: () => void }) {
  const connected = Boolean(helperConnection());
  const [browser, setBrowser] = useState<"chrome" | "edge">("chrome");
  const [setup, setSetup] = useState<{ directory: string; code: string; expires: number; opened: boolean }>();
  const [status, setStatus] = useState<Status>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (navigator.userAgent.includes("Edg/")) setBrowser("edge");
    if (!connected) return;
    let active = true;
    const refresh = async () => {
      try {
        const response = await helperFetch("/extension/status");
        if (response.ok && active) {
          setStatus(await response.json());
          onAccountsChanged();
        }
      } catch { /* Setup shows connection errors when requested. */ }
    };
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [connected]);
  const begin = async () => {
    setBusy(true); setNote("");
    try {
      const response = await helperFetch("/extension/setup", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ browser }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.detail || "Update and reopen the helper to prepare the extension.");
      setSetup(value);
    } catch (error) { setNote((error as Error).message); }
    finally { setBusy(false); }
  };
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setNote("Copied."); }
    catch { setNote("Select the text below and copy it."); }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      const response = await helperFetch("/extension/disconnect", { method: "POST" });
      if (!response.ok) throw new Error("Open the helper and try again.");
      setStatus({ paired: false, services: {} }); setSetup(undefined);
      onAccountsChanged(); setNote("Extension disconnected. Shared sessions removed.");
    } catch (error) { setNote((error as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="settings-section extension-setup">
      <h3>Use this browser&apos;s signed-in session</h3>
      <p className="settings-note">
        Recommended for Chrome and Edge. The extension shares only the music
        service you enable with the helper on this computer. Sign in to YouTube
        Music or SoundCloud in that same browser.
      </p>
      <label className="settings-row">
        Extension browser
        <select aria-label="Extension browser" value={browser} disabled={busy}
          onChange={(event) => { setBrowser(event.target.value as "chrome" | "edge"); setSetup(undefined); }}>
          <option value="chrome">Chrome</option><option value="edge">Edge</option>
        </select>
      </label>
      <button className="primary-button" disabled={!connected || busy} onClick={() => void begin()}>
        {busy ? "Preparing…" : setup ? "Generate new pairing code" : "Set up browser extension"}
      </button>
      {setup && (
        <ol className="better-steps">
          <li>
            <strong>Load the prepared extension once</strong>
            <p>{setup.opened ? "The helper opened the extension folder and browser setup." : "Open the extension page in your chosen browser."}
              {" "}Turn on Developer mode, choose <b>Load unpacked</b>, and select this folder:</p>
            <code className="extension-value">{setup.directory}</code>
            <button className="text-button" onClick={() => void copy(setup.directory)}>Copy folder path</button>{" "}
            <button className="text-button" onClick={() => void copy(`${browser}://extensions/`)}>Copy extension page address</button>
          </li>
          <li>
            <strong>Pair with this helper</strong>
            <p>Open MusicDownloader Browser Connection from the browser&apos;s Extensions menu. Paste this code and click Pair with helper. The code works once and expires in five minutes.</p>
            <code className="extension-value">{setup.code}</code>
            <button className="text-button" onClick={() => void copy(setup.code)}>Copy pairing code</button>
          </li>
          <li>
            <strong>Sign in, then connect your service</strong>
            <p>Use the extension&apos;s Open YouTube Music or Open SoundCloud link.
              Sign in normally, return to the extension and click Connect for that service.
              Approve its access prompt. Then import a track here. Keep the browser and helper open.</p>
          </li>
        </ol>
      )}
      {status?.paired && (
        <div role="status" className="settings-note">
          Extension paired. {Object.keys(status.services).length
            ? `Sessions synced: ${Object.keys(status.services).map((service) => service === "youtube" ? "YouTube Music" : "SoundCloud").join(", ")}.`
            : "Open the extension and connect a service or click Sync sessions."}
          {" "}<button className="text-button" disabled={busy} onClick={() => void disconnect()}>Disconnect extension</button>
        </div>
      )}
      {note && <p role="status" className="settings-note">{note}</p>}
      <p className="settings-note">The EXE prepares the files automatically. Browser approval is required once; no store listing is needed. Pairing survives helper restarts. Sessions refresh every two minutes and expire after fifteen minutes without refresh. The extension supports Chrome and Edge; direct browser access below also supports Firefox.</p>
    </div>
  );
}
