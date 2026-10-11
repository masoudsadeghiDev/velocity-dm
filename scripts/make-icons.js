'use strict';
// Rasterizes the SVG icon designs into the PNGs the app, installers and extension need.
// Run with: npx electron scripts/make-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// "Dark Neon": dark tile, cyan→violet download arrow, three-part segment bar
// (one colour per connection, like the app's segment map).
const DEFS = `
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B3850"/><stop offset="1" stop-color="#0E1424"/></linearGradient>
  <linearGradient id="ar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#67E8F9"/><stop offset="1" stop-color="#A78BFA"/></linearGradient>`;
const BAR = (y, w) => `<g stroke-width="${w}" stroke-linecap="round">
  <path d="M296 ${y}h124" stroke="#67E8F9"/><path d="M470 ${y}h96" stroke="#8FB2FB"/><path d="M616 ${y}h112" stroke="#A78BFA"/></g>`;

// macOS layout: artwork inside the 824px icon grid with a soft shadow (also used for installers).
const APP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>${DEFS}
  <filter id="sh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#0B1430" flood-opacity=".35"/></filter></defs>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)" filter="url(#sh)"/>
  <rect x="106" y="106" width="812" height="812" rx="180" fill="none" stroke="#fff" stroke-opacity=".16" stroke-width="10"/>
  <path d="M512 192v384 M346 414l166 166 166-166" stroke="url(#ar)" stroke-width="104" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  ${BAR(764, 60)}
</svg>`;

// Full-bleed tile for small places (browser toolbar, Windows/Linux tray and taskbar):
// no margin or shadow, so the artwork uses every pixel.
const TILE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>${DEFS}</defs>
  <rect width="1024" height="1024" rx="228" fill="url(#bg)"/>
  <path d="M512 150v440 M316 400l196 196 196-196" stroke="url(#ar)" stroke-width="124" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  ${BAR(832, 76)}
</svg>`;

// 16 px: the segment bar would be noise, so just a bigger, bolder arrow.
const TINY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>${DEFS}</defs>
  <rect width="1024" height="1024" rx="228" fill="url(#bg)"/>
  <path d="M512 170v560 M262 482l250 250 250-250" stroke="url(#ar)" stroke-width="170" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// macOS menu bar: monochrome template image (macOS tints it for light/dark menu bars).
const TRAY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <path d="M16 4 V20 M9 13.5 L16 20.5 L23 13.5" fill="none" stroke="#000" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M7 27 H25" stroke="#000" stroke-width="3.4" stroke-linecap="round"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<html></html>');
  const render = (svg, size) =>
    win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = ${size};
        const ctx = c.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, ${size}, ${size});
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = reject;
      img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
    })`);
  const write = async (svg, size, file) => {
    const dataUrl = await render(svg, size);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('wrote', path.relative(ROOT, file));
  };
  await write(APP_SVG, 1024, path.join(ROOT, 'assets/icon.png')); // macOS app + dmg
  await write(TILE_SVG, 1024, path.join(ROOT, 'assets/icon-tile.png')); // Windows/Linux installers
  await write(TILE_SVG, 32, path.join(ROOT, 'assets/tray.png')); // Windows/Linux tray
  await write(TRAY_SVG, 16, path.join(ROOT, 'assets/trayTemplate.png'));
  await write(TRAY_SVG, 32, path.join(ROOT, 'assets/trayTemplate@2x.png'));
  await write(TINY_SVG, 16, path.join(ROOT, 'extension/icons/icon16.png'));
  for (const s of [32, 48, 128]) await write(TILE_SVG, s, path.join(ROOT, `extension/icons/icon${s}.png`));
  fs.writeFileSync(path.join(ROOT, 'assets/icon.svg'), APP_SVG);
  fs.writeFileSync(path.join(ROOT, 'assets/icon-tile.svg'), TILE_SVG);
  app.quit();
});
