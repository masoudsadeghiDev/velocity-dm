'use strict';
// Renders the README banner (docs/banner.png) at 2x from HTML.
// Run with: npx electron scripts/make-banner.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const W = 1280;
const H = 440;
const SCALE = 2;

const icon = 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(ROOT, 'assets/icon-tile.svg')).toString('base64');

// Eight connections, each a slice of the file with its own progress: the app's segment map.
const segments = [0.92, 0.81, 0.74, 0.88, 0.66, 0.79, 0.58, 0.71]
  .map((p) => `<div class="seg"><i style="width:${p * 100}%"></i></div>`)
  .join('');

const features = ['Up to 32 connections', 'Pause & resume', 'Browser extension', 'Video grabber', 'Queues & scheduler']
  .map((f) => `<span class="chip"><b></b>${f}</span>`)
  .join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; margin: 0; }
html, body { background: transparent; }
body { zoom: ${SCALE}; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif; -webkit-font-smoothing: antialiased; }
.banner {
  position: relative; width: ${W}px; height: ${H}px; border-radius: 28px; overflow: hidden; color: #fff;
  background:
    radial-gradient(620px 420px at 8% 0%, rgba(34, 211, 238, .22), transparent 70%),
    radial-gradient(700px 520px at 100% 100%, rgba(139, 92, 246, .30), transparent 70%),
    linear-gradient(160deg, #18223a 0%, #0b1020 60%, #0a0e1b 100%);
  display: flex; align-items: center; padding: 0 64px; gap: 48px;
}
/* faint speed lines */
.banner::before {
  content: ""; position: absolute; inset: 0; opacity: .07;
  background: repeating-linear-gradient(115deg, transparent 0 46px, #fff 46px 47px);
  mask-image: linear-gradient(90deg, transparent 30%, #000 100%);
}
.banner::after { content: ""; position: absolute; inset: 0; border-radius: 28px; box-shadow: inset 0 0 0 1px rgba(255,255,255,.08); }
.left { position: relative; flex: 1; min-width: 0; }
.brand { display: flex; align-items: center; gap: 22px; }
.brand img { width: 104px; height: 104px; border-radius: 24px; box-shadow: 0 14px 40px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.1); }
h1 { font-size: 60px; font-weight: 800; letter-spacing: -1.5px; line-height: 1; }
h1 span { background: linear-gradient(90deg, #67e8f9, #a78bfa); -webkit-background-clip: text; color: transparent; }
.sub { margin-top: 8px; font-size: 19px; font-weight: 600; letter-spacing: .3px; color: #8ea0c4; text-transform: uppercase; }
.tag { margin-top: 28px; font-size: 23px; line-height: 1.4; color: #d6deef; max-width: 600px; }
.chips { margin-top: 26px; display: flex; flex-wrap: wrap; gap: 10px; max-width: 640px; }
.chip { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 999px; font-size: 15px; font-weight: 600; color: #e6ebf7;
  background: rgba(255,255,255,.07); box-shadow: inset 0 0 0 1px rgba(255,255,255,.10); }
.chip b { width: 8px; height: 8px; border-radius: 50%; background: linear-gradient(135deg, #67e8f9, #a78bfa); }
.card { position: relative; width: 450px; flex: none; padding: 22px 24px 20px; border-radius: 20px;
  background: rgba(255,255,255,.06); box-shadow: inset 0 0 0 1px rgba(255,255,255,.10), 0 30px 60px rgba(0,0,0,.35); backdrop-filter: blur(6px); }
.file { display: flex; align-items: center; gap: 14px; }
.ficon { width: 40px; height: 48px; border-radius: 6px; background: #e2553d; display: flex; align-items: flex-end; justify-content: center;
  padding-bottom: 6px; font-size: 10px; font-weight: 800; letter-spacing: .5px; clip-path: polygon(0 0, 70% 0, 100% 24%, 100% 100%, 0 100%); }
.fname { font-size: 17px; font-weight: 700; }
.fmeta { font-size: 13px; color: #93a1bd; margin-top: 3px; }
.big { margin-top: 18px; height: 10px; border-radius: 5px; background: rgba(255,255,255,.10); overflow: hidden; }
.big i { display: block; height: 100%; width: 76%; border-radius: 5px; background: linear-gradient(90deg, #67e8f9, #8fb2fb, #a78bfa); }
.stats { margin-top: 12px; display: flex; justify-content: space-between; font-size: 13.5px; color: #b8c3da; font-variant-numeric: tabular-nums; }
.stats b { color: #fff; font-weight: 700; }
.label { margin-top: 18px; font-size: 11.5px; font-weight: 700; letter-spacing: .8px; text-transform: uppercase; color: #7f8db0; }
.segmap { margin-top: 8px; display: grid; grid-template-columns: repeat(8, 1fr); gap: 4px; }
.seg { height: 26px; border-radius: 5px; background: rgba(255,255,255,.09); overflow: hidden; }
.seg i { display: block; height: 100%; background: linear-gradient(180deg, #67e8f9, #a78bfa); opacity: .95; }
.rows { margin-top: 16px; display: grid; gap: 8px; font-size: 13.5px; }
.row { display: flex; justify-content: space-between; color: #b8c3da; }
.row .ok { color: #4ade80; font-weight: 700; }
.row .q { color: #8ea0c4; }
</style></head><body>
<div class="banner">
  <div class="left">
    <div class="brand"><img src="${icon}"><div><h1>Velocity <span>DM</span></h1><div class="sub">Download Manager</div></div></div>
    <div class="tag">Fast, multi-connection downloads that pause, resume and survive restarts — for macOS, Windows and Linux.</div>
    <div class="chips">${features}</div>
  </div>
  <div class="card">
    <div class="file"><div class="ficon">MKV</div><div><div class="fname">Big.Buck.Bunny.4K.mkv</div><div class="fmeta">Receiving data · resume supported</div></div></div>
    <div class="big"><i></i></div>
    <div class="stats"><span><b>935 MB</b> of 1.2 GB</span><span><b>24.6 MB/s</b></span><span><b>12 sec</b> left</span></div>
    <div class="label">8 connections</div>
    <div class="segmap">${segments}</div>
    <div class="rows">
      <div class="row"><span>ubuntu-24.04-desktop.iso</span><span class="ok">Complete</span></div>
      <div class="row"><span>podcast-episode-142.mp3</span><span class="q">Queued</span></div>
    </div>
  </div>
</div></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W * SCALE, height: H * SCALE, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: W * SCALE, height: H * SCALE });
  fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs/banner.png'), img.toPNG());
  console.log('wrote docs/banner.png', img.getSize());
  app.quit();
});
