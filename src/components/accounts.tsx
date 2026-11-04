"use client";
import { useEffect, useState } from "react";
import { helperFetch } from "@/lib/helper";
type Service = "youtube" | "soundcloud";
export default function Accounts() {
  const [accounts, setAccounts] = useState<Partial<Record<Service, string>>>(
    {},
  );
  const [browser, setBrowser] = useState("chrome");
  const [status, setStatus] = useState("");
  useEffect(() => {
    void helperFetch("/accounts")
      .then((r) => r.json())
      .then((v) => setAccounts(v.accounts || {}))
      .catch(() => {});
  }, []);
  async function save(service: Service, connect: boolean) {
    const next = { ...accounts };
    if (connect) next[service] = browser;
    else delete next[service];
    try {
      const response = await helperFetch("/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!response.ok)
        throw new Error("Update the helper to connect accounts.");
      setAccounts((await response.json()).accounts);
      setStatus(
        connect
          ? "Enabled. Re-import your link to check the streams your account can access."
          : "Account access removed.",
      );
    } catch (error) {
      setStatus((error as Error).message);
    }
  }
  return (
    <details className="account-setup">
      <summary>Connect accounts for better sources</summary>
      <p>
        Sign in using the browser selected below. Premium quality requires an
        eligible subscription and track.
      </p>
      <select
        aria-label="Account browser"
        value={browser}
        onChange={(e) => setBrowser(e.target.value)}
      >
        {["chrome", "edge", "firefox", "brave", "chromium", "safari"].map(
          (name) => (
            <option key={name} value={name}>
              {name[0].toUpperCase() + name.slice(1)}
            </option>
          ),
        )}
      </select>
      {(["youtube", "soundcloud"] as const).map((service) => (
        <div key={service} className="account-row">
          <strong>
            {service === "youtube" ? "Google / YouTube Music" : "SoundCloud"}
          </strong>
          <ol>
            <li>
              <a
                target="_blank"
                rel="noreferrer"
                href={
                  service === "youtube"
                    ? "https://music.youtube.com/"
                    : "https://soundcloud.com/signin"
                }
              >
                Open {service === "youtube" ? "YouTube Music" : "SoundCloud"}{" "}
                and sign in
              </a>{" "}
              in your selected browser.
            </li>
            <li>
              Play the song.{" "}
              {service === "youtube"
                ? "Use High quality with Music Premium."
                : "With Go+, choose High quality in Settings → Streaming."}
            </li>
            <li>
              Close that browser if cookie access fails, then enable access
              below. Allow your system&apos;s keychain prompt if asked.
            </li>
          </ol>
          <button
            className="text-button"
            onClick={() => void save(service, !accounts[service])}
          >
            {accounts[service]
              ? `Disconnect ${accounts[service]}`
              : "Use this account"}
          </button>
        </div>
      ))}
      <small>
        Enabling access lets the helper read cookies from that local browser and
        use the relevant service session. Cookies stay on your computer. Use its
        default profile. Firefox is an alternative if Chrome or Edge blocks
        access.
      </small>
      <p>
        Spotify, Apple Music, and Amazon Music links use matched recordings;
        signing in does not unlock their protected audio here.
      </p>
      {status && <p role="status">{status}</p>}
    </details>
  );
}
