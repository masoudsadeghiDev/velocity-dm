'use strict';
// Shows a "Download this video" button over playing videos (IDM's video panel).
(() => {
  if (window.__velocityDm) return;
  window.__velocityDm = true;

  let host = null;
  let shadow = null;
  let btn = null;
  let menu = null;
  let current = null;
  let hideTimer = null;
  let overHost = false;
  let raf = 0;

  const CSS = `
    :host { all: initial; }
    .wrap { font: 12px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
    .b { display: inline-flex; align-items: center; gap: 6px; border: 0; cursor: pointer; padding: 6px 11px 6px 8px; border-radius: 8px;
         background: rgba(30, 80, 210, .92); color: #fff; font: inherit; font-weight: 600; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
    .b:hover { background: rgb(36, 96, 240); }
    .b svg { width: 16px; height: 16px; fill: none; stroke: #fff; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
    .menu { background: #fff; color: #1d2330; border-radius: 9px; box-shadow: 0 8px 26px rgba(0,0,0,.35); padding: 5px; min-width: 260px; max-width: 380px; }
    .menu[hidden] { display: none; }
    .it { padding: 7px 9px; border-radius: 6px; cursor: pointer; display: flex; flex-direction: column; }
    .it:hover { background: #2f6fed; color: #fff; }
    .it .s { font-size: 11px; opacity: .7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .msg { padding: 8px 10px; color: #5b6475; }
    @media (prefers-color-scheme: dark) { .menu { background: #23262d; color: #e6e9ef; } .msg { color: #a9b0be; } }
  `;

  function ensure() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;display:none;';
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    btn = document.createElement('button');
    btn.className = 'b';
    btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg><span>Download this video</span>';
    menu = document.createElement('div');
    menu.className = 'menu';
    menu.hidden = true;
    wrap.append(btn, menu);
    shadow.append(style, wrap);
    document.documentElement.append(host);
    btn.addEventListener('click', onClick);
    host.addEventListener('mouseenter', () => {
      overHost = true;
      clearTimeout(hideTimer);
    });
    host.addEventListener('mouseleave', () => {
      overHost = false;
      scheduleHide();
    });
  }

  function show(video, r) {
    ensure();
    clearTimeout(hideTimer);
    current = video;
    host.style.display = 'block';
    const w = host.offsetWidth || 200;
    host.style.top = `${Math.max(6, r.top + 10)}px`;
    host.style.left = `${Math.max(6, Math.min(r.right - w - 10, window.innerWidth - w - 6))}px`;
  }

  function hide() {
    if (!host) return;
    host.style.display = 'none';
    menu.hidden = true;
    current = null;
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => !overHost && hide(), 1500);
  }

  function check(x, y) {
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (r.width >= 200 && r.height >= 120 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return show(v, r);
    }
    if (!overHost && current) scheduleHide();
  }

  document.addEventListener(
    'mousemove',
    (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        check(e.clientX, e.clientY);
      });
    },
    { passive: true, capture: true }
  );
  window.addEventListener('scroll', () => current && hide(), { passive: true, capture: true });

  function fmtSize(n) {
    if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i > 1 ? 1 : 0)} ${u[i]}`;
  }
  function fmtDur(s) {
    if (!s) return '';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }
  function label(e) {
    if (e.kind === 'hls') return [`Video stream${e.quality ? ` · ${e.quality}` : ''}`, [fmtDur(e.duration), 'HLS'].filter(Boolean).join(' · ')];
    const ext = (/\.([a-z0-9]{2,4})(\?|$)/i.exec(new URL(e.url).pathname) || [])[1] || e.mime?.split('/')[1] || '';
    return [`${e.kind === 'audio' ? 'Audio' : 'Video'}${ext ? ` (${ext.toUpperCase()})` : ''}`, [fmtSize(e.size), new URL(e.url).host].filter(Boolean).join(' · ')];
  }

  function message(text) {
    menu.replaceChildren(Object.assign(document.createElement('div'), { className: 'msg', textContent: text }));
    menu.hidden = false;
  }

  async function download(entry) {
    const r = await chrome.runtime.sendMessage({ type: 'downloadMedia', entry });
    if (r?.ok) message('Sent to Velocity DM ✓');
    setTimeout(() => (menu.hidden = true), 1800);
  }

  async function onClick() {
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    const extra = [];
    const src = current?.currentSrc || current?.src;
    if (src && /^https?:/i.test(src)) extra.push({ url: src, kind: 'video', mime: '', size: 0 });
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'media', extra });
    } catch {
      return message('The extension was updated — reload this page.');
    }
    const list = res?.media || [];
    if (!list.length) return message('No downloadable stream found yet. Play the video for a few seconds, then try again.');
    if (list.length === 1) return download(list[0]);
    menu.replaceChildren(
      ...list.map((e) => {
        const [title, sub] = label(e);
        const it = document.createElement('div');
        it.className = 'it';
        it.append(Object.assign(document.createElement('span'), { textContent: title }), Object.assign(document.createElement('span'), { className: 's', textContent: sub }));
        it.addEventListener('click', () => download(e));
        return it;
      })
    );
    menu.hidden = false;
  }
})();
