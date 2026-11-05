# Browser session connection

The helper EXE includes the MusicDownloader Browser Connection extension. It
prepares `~/.musicdownloader/browser-extension` automatically when it starts.
The browser still requires a one-time installation approval. This build uses
Chrome/Edge's **Load unpacked** flow; it is not published to an extension store.

## Setup

1. Run the new helper EXE. In the app, choose **Sign in for better audio**.
2. Choose Chrome or Edge under **Use this browser's signed-in session**, then
   **Set up browser extension**. On Windows the helper opens the extension
   directory and requests a new browser window at its extension page. If Edge
   does not navigate there, copy the visible `edge://extensions/` address from
   the app, paste it in Edge's address bar and press Enter. Chrome uses
   `chrome://extensions/`.
3. Turn on **Developer mode**. Choose **Load unpacked**, paste the folder path
   shown by the app, and select that folder. Keep that folder in place.
4. The extension opens its connection tab automatically after installation.
   If needed, open **MusicDownloader Browser Connection** in the browser's
   Extensions menu (the puzzle piece). Paste the app's pairing code and choose **Pair with helper**.
   Codes work once and expire after five minutes. Use **Generate new pairing
   code** if necessary.
5. In the extension, open YouTube Music or SoundCloud. Sign in normally using
   your subscription account in this same browser profile.
6. Return to the extension, choose **Connect YouTube Music** or **Connect
   SoundCloud**, and approve access to that service. Re-import the track in the
   app to use the updated session. The app shows which sessions have synced.

Keep the browser and helper running while downloading. Once paired, the
extension refreshes enabled sessions every two minutes. If you restart the
helper, click **Sync sessions** or wait for the next refresh. Changing browser
profiles or pairing another extension requires a new pairing code.

The extension requests only localhost access at installation. Service host
access is requested when you connect that service. Its cookie permission is
used to share that service's session with the local helper; no content scripts
run on pages and no session data is sent to the hosted app.

## Disconnect and troubleshoot

- **No session cookies found:** sign in using the same non-incognito browser
  profile that contains the extension, then choose **Sync sessions**.
- **Helper unavailable:** open the helper. If it was updated, reload the
  extension on the browser's extension page. Generate a new pairing code if
  the app says disconnected or you paired a different browser.
- **Expired session:** use **Sync sessions**. Helper session leases last fifteen
  minutes. Refreshing the session does not prove a Premium/Go+ entitlement.
- **Remove access:** choose **Disconnect extension** in the app, or
  **Disconnect** in the extension while the helper is open. The helper deletes
  its temporary session jars and revokes the extension's credential. Browser
  permission can also be removed on the extension's Details page.
- **Update:** the EXE refreshes the extension files. Choose **Reload** on the
  browser's extension page if it was already installed.

The helper keeps paired-extension credentials locally to avoid pairing on
every restart. Cookie jars are temporary, provider-scoped, and deleted on clean
shutdown, disconnect, or lease expiry. An interrupted process can leave a jar
in the OS temporary directory until normal temp cleanup; this is session
material, so do not share temporary files. The helper never returns cookie
values to the app or extension popup.

YouTube Music Premium and SoundCloud Go+ can expose higher-quality streams on
supported tracks. Neither the extension nor FLAC conversion creates a lossless
master from a lossy stream. The extractor still selects the best accessible
non-preview audio and the app reports the actual selected stream. Provider
changes, account challenges, and stream restrictions can still prevent access.

## Validation

The Windows build passed TypeScript checking, 92 unit/integration tests, and 21
app browser tests. The real Chromium extension test covers cookie transfer in
a disposable profile, helper restart recovery without re-pairing, and deletion
of session files on disconnect. It uses fixture cookies, not a personal login.
The packaged EXE also passed its self-test, including extraction of all five
extension files and operation of the bundled runtime with an empty PATH.
