const SERVICES = { youtube: "youtube.com", soundcloud: "soundcloud.com" };

async function request(connection, path, body) {
  const response = await fetch(`http://127.0.0.1:${connection.port}/extension/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-MusicDownloader-Extension": chrome.runtime.id,
      ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    credentials: "omit",
    signal: AbortSignal.timeout(10000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.detail || "Open the helper and pair again.");
  return value;
}

async function sync(enableService) {
  const { connection, services = [] } = await chrome.storage.local.get(["connection", "services"]);
  if (!connection) throw new Error("Paste the pairing code from the app first.");
  const results = {};
  for (const service of new Set([...services, ...(enableService ? [enableService] : [])])) {
    const domain = SERVICES[service];
    if (!domain) continue;
    const permitted = await chrome.permissions.contains({ origins: [`https://*.${domain}/*`] });
    // Revoked browser permission must also clear any existing helper session.
    const cookies = permitted ? await chrome.cookies.getAll({ domain }) : [];
    results[service] = await request(connection, "session", {
      service, cookies, enable: enableService === service && permitted,
    });
  }
  if (enableService) {
    if (!results[enableService]?.active) throw new Error("Allow the service permission to connect.");
    await chrome.storage.local.set({ services: [...new Set([...services, enableService])] });
  }
  await chrome.storage.local.set({ lastSync: Date.now(), lastError: "" });
  return results;
}

async function handle(message) {
  if (message.action === "pair") {
    const match = /^(\d{4,5})\.([A-Za-z0-9_-]{32})$/.exec(String(message.code).trim());
    if (!match || +match[1] > 65535 || +match[1] < 1024) throw new Error("Copy the full pairing code from the app.");
    const connection = { port: +match[1] };
    const { token } = await request(connection, "pair", { code: match[2] });
    await chrome.storage.local.set({ connection: { ...connection, token }, services: [], lastError: "", lastSync: null });
    await chrome.alarms.create("refresh", { periodInMinutes: 2 });
    return { paired: true };
  }
  if (message.action === "sync") return sync();
  if (message.action === "enable") {
    if (!Object.hasOwn(SERVICES, message.service)) throw new Error("Unknown service.");
    return sync(message.service);
  }
  const { connection } = await chrome.storage.local.get("connection");
  if (message.action === "disconnect") {
    if (connection) await request(connection, "disconnect", {});
    await chrome.storage.local.clear();
    await chrome.alarms.clear("refresh");
    // Session revocation has already succeeded. Browser-managed installations
    // may retain a required permission; that must not undo local disconnect.
    await chrome.permissions.remove({ origins: Object.values(SERVICES).map((domain) => `https://*.${domain}/*`) }).catch(() => {});
    return { paired: false };
  }
  if (message.action === "status") {
    return connection ? request(connection, "status") : { paired: false, services: {} };
  }
  throw new Error("Unknown extension action.");
}

// No content scripts or externally-connectable messages. Only our own popup
// can ask this worker to access service sessions; cookie values never return.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return;
  handle(message).then((value) => respond({ value })).catch((error) => respond({ error: error.message }));
  return true;
});

async function refresh() {
  try { await sync(); }
  catch { await chrome.storage.local.set({ lastError: "Open the helper, then click Sync sessions. Pair again if disconnected in the app." }); }
}
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "refresh") void refresh(); });
chrome.runtime.onStartup.addListener(() => {
  void chrome.alarms.create("refresh", { periodInMinutes: 2 });
  void refresh();
});
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install")
    void chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
});
chrome.permissions.onRemoved.addListener(() => { void refresh(); });
// Chrome can suspend a worker between alarms. Recreate its refresh schedule
// when loaded after an extension update as well as a normal browser restart.
void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
void chrome.storage.local.get("connection").then(({ connection }) => {
  if (connection) void chrome.alarms.create("refresh", { periodInMinutes: 2 });
});
