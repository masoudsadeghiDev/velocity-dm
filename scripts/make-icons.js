'use strict';
// Rasterizes the SVG icon designs into the PNGs the app and extension need.
// Run with: npx electron scripts/make-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const APP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#4a8dff"/><stop offset="1" stop-color="#1747b8"/>
    </linearGradient>
  </defs>
  <rect x="40" y="40" width="432" height="432" rx="100" fill="url(#g)"/>
  <path d="M256 110 V300 M168 222 L256 310 L344 222" fill="none" stroke="#fff" stroke-width="46" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M150 380 H362" stroke="#8fe6ff" stroke-width="38" stroke-linecap="round"/>
</svg>`;

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
        c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
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
  await write(APP_SVG, 1024, path.join(ROOT, 'assets/icon.png'));
  await write(APP_SVG, 32, path.join(ROOT, 'assets/tray.png'));
  await write(TRAY_SVG, 16, path.join(ROOT, 'assets/trayTemplate.png'));
  await write(TRAY_SVG, 32, path.join(ROOT, 'assets/trayTemplate@2x.png'));
  for (const s of [16, 32, 48, 128]) await write(APP_SVG, s, path.join(ROOT, `extension/icons/icon${s}.png`));
  fs.writeFileSync(path.join(ROOT, 'assets/icon.svg'), APP_SVG);
  app.quit();
});
