# Velocity Download Manager

A desktop download manager in the spirit of Internet Download Manager (IDM), for macOS, Windows and Linux (Electron).

## Features

| IDM feature | Velocity DM |
| --- | --- |
| Multi-connection downloading with **dynamic file segmentation** | Up to 32 connections per file. When a connection finishes its part, it takes over half of the largest remaining part, so all connections stay busy until the end. Connection count can be changed while a download is running. |
| **Pause / resume**, including after quitting or crashing | Segment progress is saved continuously. A partial file resumes from where each connection stopped. If the file on the server changed, you're told to restart it. |
| **Resume All / expired links** | **Resume All** resumes every stopped download, sending downloads that belong to a queue back through it (so its "at a time" limit still applies). Signed links that expire (`expires=…`, `Expires=…`, S3/GCS `X-Amz-*`/`X-Goog-*`) are detected, even on paused downloads. A banner appears when links have expired, and **Paste New Links & Resume** matches freshly copied links to your downloads by file name. Each download then continues from where it stopped, and finished segments of video streams are kept. |
| Error recovery | Retries with backoff, recovers dropped connections, backs off when a server limits connections (HTTP 429/503, or 403 on extra connections), and re-resolves expired CDN links. Expired signed links fail with a clear error; paste a fresh link under Properties → Address to continue. |
| **Browser integration** | Extension for Chrome, Edge, Brave, Opera, Vivaldi and Firefox. It takes over downloads of the file types you choose and adds right-click **Download with Velocity DM**, **Download selected links** and **Download all links**. Cookies and referer are passed along, so links that require a login still work. |
| **Video grabber** | Detects video and audio on web pages and shows a **Download this video** button on top of the player. Handles **HLS (m3u8)** streams: you can pick the quality, AES-128 encrypted streams are decrypted, separate audio tracks are merged in, and the result is saved as MP4 when ffmpeg is installed. |
| Download categories | Compressed, Documents, Music, Programs, Video and General. Each has its own file extensions and save folder. |
| **Queues and Scheduler** | Multiple queues with a "N files at a time" limit and reorderable items. Each queue can start and stop at set times, once or on chosen days, retry failed files, and then quit the app, sleep, or shut down the computer. |
| **Speed limiter** | A global limit (toolbar, tray or menu) plus a separate limit per download. |
| **Site Grabber** | Crawls a website to a chosen depth and lists every file of the selected types so you can download them all. |
| **Batch download** | Paste a **list of links** (one per line, or any text containing them), e.g. every episode of a season. Each link becomes its own download, and you can pick the save folder and how many run at once. Also supports IDM's pattern mode: `http://site/img*.jpg` from 1 to 100, with optional zero-padding, or letters a–z. **Tasks → Add Batch Download from Clipboard** (⌘⇧B) takes whatever links you copied. Pasting several links into Add URL or the main window works too. |
| Clipboard monitoring | Copying a link to a downloadable file opens the Download File Info dialog. |
| Progress window | Per-download window with a live **segment map** showing each connection's part, a connections table and a speed limit for that download. A "Download complete" window offers Open and Open Folder. |
| Other | Drag and drop or paste links into the window; HTTP proxy (including HTTPS via CONNECT); HTTP Basic login; custom User-Agent; checksum check (MD5/SHA-1/SHA-256/SHA-512); keep-awake while downloading; menu-bar/tray icon with live speed; notifications; dock badge; import links from a file and export the list; light and dark themes. |

## Download

Get the latest version from the [Releases page](../../releases/latest).

| Platform | File |
| --- | --- |
| macOS, Apple Silicon (M1 and newer) | `Velocity-DM-<version>-mac-arm64.dmg` |
| macOS, Intel | `Velocity-DM-<version>-mac-x64.dmg` |
| Windows 10/11, 64-bit | `Velocity-DM-<version>-win-x64.exe` |
| Linux, x86-64 | `Velocity-DM-<version>-linux-x86_64.AppImage` |
| Browser extension | `Velocity-DM-<version>-browser-extension.zip` |

The builds are not signed with a paid developer certificate yet, so your system asks for confirmation the first time:

- **macOS:** open the `.dmg` and drag **Velocity DM** to Applications. When you first open it, macOS says it can't verify the developer. Go to **System Settings → Privacy & Security** and click **Open Anyway**. You only need to do this once.
- **Windows:** if SmartScreen shows "Windows protected your PC", click **More info → Run anyway**.
- **Linux:** run `chmod +x Velocity-DM-*.AppImage`, then start the AppImage.

To add the browser extension, unzip it and follow [Install the browser extension](#install-the-browser-extension) below. The extension is also included in the app; **Help → Browser Extension Setup** shows where.

## Run from source

```bash
npm install
```

```bash
npm start
```

If Electron complains about a missing binary after `npm install`, run `node node_modules/electron/install.js` once.

For MP4 output from streaming videos, install ffmpeg (`brew install ffmpeg` on macOS). Without ffmpeg, streams are saved as `.ts`, which VLC and most players can open.

## Install the browser extension

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension/` folder.

In Firefox, open `about:debugging` → **This Firefox** → **Load Temporary Add-on…** and select `extension/manifest.json`.

The app has to be running. The extension reaches it at `127.0.0.1:9614`; you can change the port under Options → Browser & File Types. Help → Browser Extension Setup in the app shows the folder path.

## Tests

```bash
npm test
```

There are 32 tests that run against a local test server (`test/server.js`) imitating real-world servers: byte ranges, throttling, connection limits, dropped connections, redirects, `Content-Disposition` names, Basic auth, chunked bodies, and plain and AES-128-encrypted HLS. They cover multi-connection integrity (SHA-256 of the result), resuming after a simulated app restart, the speed limiter, proxy support, queues, the scheduler, the Site Grabber and batch expansion. When ffmpeg is installed, a real ffmpeg-generated HLS stream is also remuxed to MP4.

To try the GUI against the test server, run `node test/server.js` and add `http://127.0.0.1:8765/file/52428800?rate=2000000` (a 50 MB file throttled to 2 MB/s per connection).

## Packaging

```bash
npm run dist:mac
```

```bash
npm run dist:win
```

```bash
npm run dist:linux
```

Output goes to `dist/`. All three can be built from a Mac. macOS builds are ad-hoc signed (`mac.identity: "-"`). To get rid of the first-launch warnings, sign with an Apple Developer ID (plus notarization) and a Windows code-signing certificate; see [electron.build/code-signing](https://www.electron.build/code-signing). The browser extension is bundled into each app at `resources/extension`.

## How it fits together

```
src/main/
  engine/http.js          HTTP client: redirects, ranges, proxy/CONNECT, timeouts, abort
  engine/HttpDownload.js  multi-connection engine with dynamic segmentation and resume
  engine/HlsDownload.js   HLS downloader: parallel segments, AES-128, ffmpeg remux
  engine/m3u8.js          playlist parser
  engine/limiter.js       shared token-bucket speed limiter
  engine/files.js         file names, Content-Disposition, categories, atomic JSON
  DownloadManager.js      downloads, queues, persistence, events (no Electron, testable)
  Scheduler.js            timed queue start/stop
  BrowserBridge.js        127.0.0.1 endpoint for the extension
  tools.js                Site Grabber and batch expansion
  main.js / preload.js    Electron windows, tray, menus, IPC, notifications, clipboard
src/renderer/             main window, progress window, Download File Info window
extension/                MV3 browser extension (capture, context menus, video grabber)
```

**Security.** Renderers run sandboxed with context isolation and no Node access, behind a strict CSP, and cannot navigate away. The browser bridge listens only on 127.0.0.1. It rejects foreign `Host` headers (DNS rebinding), accepts only browser-extension origins, and requires a JSON content type. Because of this, ordinary web pages can't push downloads into the app. Cookies and credentials are dropped on cross-origin redirects. Deleting a finished file moves it to the Trash.

**Data.** Download state and settings are stored as JSON in the app's user-data folder (`~/Library/Application Support/velocity-dm` on macOS). Set `VDM_USER_DATA=/some/dir` to use a separate profile.

## Not included

- YouTube and DRM-protected streams (Widevine/FairPlay, SAMPLE-AES).
- DASH (`.mpd`) streams.
- Live HLS streams.
- FTP and BitTorrent.
