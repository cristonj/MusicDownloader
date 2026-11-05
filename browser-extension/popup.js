const status = document.querySelector("#status");
const buttons = [...document.querySelectorAll("button")];
async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response.value;
}
async function run(action, success) {
  buttons.forEach((button) => button.disabled = true);
  status.textContent = "Connecting…";
  try { const result = await action(); status.textContent = typeof success === "function" ? success(result) : success; }
  catch (error) { status.textContent = error.message || "Open the helper and try again."; }
  finally { buttons.forEach((button) => button.disabled = false); }
}
document.querySelector("#pair-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void run(() => send({ action: "pair", code: document.querySelector("#code").value }),
    "Paired. Sign in above, then connect each service you want to use.");
  document.querySelector("#code").value = "";
});
for (const [service, domain] of [["youtube", "youtube.com"], ["soundcloud", "soundcloud.com"]]) {
  document.querySelector(`#${service}`).addEventListener("click", () => {
    // Call permissions.request during the click gesture, before awaiting work.
    const permission = chrome.permissions.request({ origins: [`https://*.${domain}/*`] });
    void run(async () => {
      if (!await permission) throw new Error("Allow this service to share its session with the helper.");
      return send({ action: "enable", service });
    }, (result) => result[service]?.cookieCount
      ? "Session synced. Import a track in MusicDownloader to use this account. Premium access depends on your account and track."
      : "No session cookies found. Sign in using this browser, then click Sync sessions.");
  });
}
document.querySelector("#sync").addEventListener("click", () => void run(() => send({ action: "sync" }),
  (result) => Object.keys(result).length ? "Sessions synced with the helper." : "Connect a service above first."));
document.querySelector("#disconnect").addEventListener("click", () => void run(() => send({ action: "disconnect" }), "Disconnected. The helper removed the shared sessions."));
void run(() => send({ action: "status" }), (result) => !result.paired
  ? "Paste the pairing code from MusicDownloader to begin."
  : `Helper paired. Active sessions: ${Object.keys(result.services).join(", ") || "none; connect a service above"}.`);
