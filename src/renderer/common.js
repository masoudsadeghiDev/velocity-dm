'use strict';
/* Shared helpers for every renderer page. Exposed as window.U */
(function () {
  const ICONS = {
    link: '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.2-1.2"/>',
    play: '<path d="M7 4.5v15l12.5-7.5z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
    stopAll: '<rect x="3.5" y="8" width="10" height="10" rx="1.5"/><path d="M8 4.5h10a1.5 1.5 0 0 1 1.5 1.5v10"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
    trashDone: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/><path d="M9 13l2 2 4-4"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    queuePlay: '<path d="M3 6h12M3 12h8M3 18h8"/><path d="M15 12.5v8l6.5-4z"/>',
    queueStop: '<path d="M3 6h12M3 12h8M3 18h8"/><rect x="14" y="13" width="7" height="7" rx="1"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    layers: '<path d="M12 3l9 4.5-9 4.5-9-4.5z"/><path d="M3 12l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5"/>',
    gauge: '<path d="M12 14l4-4"/><path d="M3.5 18.5a10 10 0 1 1 17 0"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4"/>',
    doc: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M8.5 13h7M8.5 17h5"/>',
    music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    app: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>',
    video: '<rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="M15.5 10.5l6-3.5v10l-6-3.5"/>',
    file: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    inbox: '<path d="M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9L20 8.5"/><path d="M20 3.5v5h-5"/>',
    resumeAll: '<path d="M20 12a8 8 0 1 1-2.6-5.9L20 8.5"/><path d="M20 3.5v5h-5"/><path d="M10 8.8v6.4l5.2-3.2z"/>',
    linkOff: '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.2-1.2"/><path d="M3 3l18 18"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
    open: '<path d="M14 3h7v7M10 14L21 3M19 14v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    puzzle: '<path d="M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3z"/>',
    zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    hash: '<path d="M5 9h14M5 15h14M10 3L8 21M16 3l-2 18"/>',
  };

  function icon(name, cls = '') {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', `i ${cls}`);
    svg.innerHTML = ICONS[name] || ICONS.file; // static, trusted markup
    return svg;
  }

  /** Tiny DOM builder: el('div', {class:'x', onclick}, child, 'text') */
  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k in e && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
  function bytes(n) {
    if (n == null || n < 0 || !Number.isFinite(n)) return '';
    let i = 0;
    while (n >= 1024 && i < UNITS.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i === 0 ? 0 : n < 10 ? 2 : n < 100 ? 1 : 0)} ${UNITS[i]}`;
  }
  const speed = (bps) => (bps > 0 ? `${bytes(bps)}/s` : '');
  function eta(sec) {
    if (sec == null || sec < 0 || !Number.isFinite(sec)) return '';
    sec = Math.round(sec);
    if (sec < 60) return `${sec} sec`;
    if (sec < 3600) return `${Math.floor(sec / 60)} min ${String(sec % 60).padStart(2, '0')} sec`;
    if (sec < 86400) return `${Math.floor(sec / 3600)} hr ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')} min`;
    return `${Math.floor(sec / 86400)} d ${Math.floor((sec % 86400) / 3600)} hr`;
  }
  function date(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return sameDay ? `Today ${t}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })} ${t}`;
  }
  function percent(it) {
    if (it.status === 'completed') return 100;
    if (it.type === 'hls' && it.hlsProgress != null) return it.hlsProgress * 100;
    if (it.size > 0) return Math.min(100, (it.downloaded / it.size) * 100);
    return -1;
  }
  function sizeText(it) {
    if (it.size > 0) return (it.sizeEstimated ? '~' : '') + bytes(it.size);
    if (it.downloaded > 0 && it.status !== 'completed') return bytes(it.downloaded) + ' / ?';
    return it.status === 'completed' ? bytes(it.downloaded) : '';
  }
  /** A stopped download that can only continue with a fresh link. */
  function linkExpired(it) {
    if (it.status === 'completed' || isActive(it)) return false;
    return !!it.needsNewLink || (it.linkExpiresAt > 0 && it.linkExpiresAt < Date.now());
  }

  function statusText(it) {
    const p = percent(it);
    if (linkExpired(it)) return 'Link expired';
    switch (it.status) {
      case 'completed': return 'Complete';
      case 'failed': return 'Error';
      case 'queued': return 'Queued';
      case 'connecting': return 'Connecting…';
      case 'finishing': return 'Finishing…';
      case 'downloading': return p >= 0 ? `${p.toFixed(1)}%` : bytes(it.downloaded);
      default: return it.downloaded > 0 ? (p >= 0 ? `Paused ${p.toFixed(1)}%` : 'Paused') : 'Not started';
    }
  }

  const CAT = {
    compressed: { icon: 'archive', color: '#d99a23' },
    documents: { icon: 'doc', color: '#3a78e0' },
    music: { icon: 'music', color: '#a855d6' },
    programs: { icon: 'app', color: '#5c6b82' },
    video: { icon: 'video', color: '#e2553d' },
    general: { icon: 'file', color: '#8a94a6' },
  };
  function fileIcon(it, big = false) {
    const m = /\.([a-z0-9]{1,5})$/i.exec(it.fileName || '');
    const ext = m ? m[1] : '';
    let color = (CAT[it.category] || CAT.general).color;
    if (/^pdf$/i.test(ext)) color = '#d64545';
    return el('div', { class: `ficon${big ? ' big' : ''}`, style: { '--c': color } }, ext.slice(0, 4));
  }

  function isActive(it) {
    return it.status === 'connecting' || it.status === 'downloading' || it.status === 'finishing';
  }

  // Drawn segment map: each connection's range and how much of it is done.
  function drawSegments(canvas, it) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w) return;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    ctx.fillStyle = css.getPropertyValue('--bar-bg');
    ctx.fillRect(0, 0, w, h);
    const total = it.size > 0 ? it.size : 0;
    if (it.status === 'completed') {
      ctx.fillStyle = css.getPropertyValue('--seg-done');
      ctx.fillRect(0, 0, w, h);
      return;
    }
    if (it.type === 'hls' || !total) {
      const p = percent(it);
      if (p > 0) {
        ctx.fillStyle = css.getPropertyValue('--seg-done');
        ctx.fillRect(0, 0, (w * p) / 100, h);
      }
      return;
    }
    for (const [start, end, done, active] of it.segments || []) {
      const x = (start / total) * w;
      const dw = (done / total) * w;
      ctx.fillStyle = css.getPropertyValue(active ? '--seg-active' : '--seg-done');
      ctx.fillRect(x, 0, Math.max(dw, done > 0 ? 1 : 0), h);
      if (active) {
        ctx.fillStyle = css.getPropertyValue('--seg-done');
        ctx.fillRect(x + dw - Math.min(dw, 2), 0, Math.min(dw, 2), h);
      }
      if (start > 0) {
        ctx.fillStyle = css.getPropertyValue('--panel');
        ctx.fillRect(x, 0, 1, h);
      }
      void end;
    }
  }

  function categoryDir(settings, category) {
    const cat = settings.categories.find((c) => c.id === category);
    if (cat?.dir) return cat.dir;
    if (!settings.useCategoryFolders || category === 'general' || !cat) return settings.downloadDir;
    const sep = settings.downloadDir.includes('\\') ? '\\' : '/';
    return settings.downloadDir.replace(/[\\/]+$/, '') + sep + cat.name;
  }
  function categoryForName(settings, name) {
    const m = /\.([a-z0-9]{1,10})$/i.exec(name || '');
    const ext = m ? m[1].toLowerCase() : '';
    for (const c of settings.categories) if (c.exts.includes(ext)) return c.id;
    return 'general';
  }
  function splitPath(p) {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i), name: p.slice(i + 1) };
  }
  function joinPath(dir, name) {
    const sep = dir.includes('\\') ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + name;
  }

  /**
   * The "Download File Info" form (IDM's dialog shown before a download starts).
   * Used in the Add URL dialog and in the standalone capture window.
   * Returns { root, focus } and calls onDone(result|null).
   */
  function newDownloadForm({ request, settings, queues, env, onDone, onMultiple }) {
    const allCats = [...settings.categories.map((c) => ({ id: c.id, name: c.name })), { id: 'general', name: 'General' }];
    let info = null;
    let userPickedPath = false;

    const urlInput = el('input', { type: 'url', value: request.url || '', spellcheck: false });
    const catSel = el('select', {}, allCats.map((c) => el('option', { value: c.id }, c.name)));
    const pathInput = el('input', { type: 'text', spellcheck: false });
    const browse = el('button', { class: 'btn sm', type: 'button' }, '…');
    const desc = el('input', { type: 'text', placeholder: 'Optional', value: request.description || '' });
    const meta = el('div', { class: 'muted small' }, 'Getting file information…');
    const variantSel = el('select');
    const variantRow = el('div', { class: 'row hidden' }, variantSel);
    const variantLabel = el('label', { class: 'hidden' }, 'Quality');
    const showVariants = (on) => {
      variantRow.classList.toggle('hidden', !on);
      variantLabel.classList.toggle('hidden', !on);
    };
    const err = el('div', { class: 'error-box hidden full' });
    const authToggle = el('label', { class: 'chk' }, el('input', { type: 'checkbox' }), 'Use authorization');
    const user = el('input', { type: 'text', placeholder: 'Username', value: request.auth?.username || '' });
    const pass = el('input', { type: 'password', placeholder: 'Password' });
    const authRow = el('div', { class: 'row hidden' }, user, pass);
    authToggle.querySelector('input').addEventListener('change', (e) => authRow.classList.toggle('hidden', !e.target.checked));
    if (request.auth?.username) {
      authToggle.querySelector('input').checked = true;
      authRow.classList.remove('hidden');
    }

    const queueSel = el('select', {}, queues.map((q) => el('option', { value: q.id }, q.name)));
    const startBtn = el('button', { class: 'btn primary', type: 'button' }, icon('download'), 'Start Download');
    const laterBtn = el('button', { class: 'btn', type: 'button' }, 'Download Later');
    const cancelBtn = el('button', { class: 'btn', type: 'button' }, 'Cancel');

    function setName(name, category) {
      const cat = category || categoryForName(settings, name);
      catSel.value = cat;
      if (!userPickedPath) pathInput.value = joinPath(categoryDir(settings, cat), name);
      requestAnimationFrame(() => (pathInput.scrollLeft = pathInput.scrollWidth)); // show the file name
    }

    catSel.addEventListener('change', () => {
      const { name } = splitPath(pathInput.value);
      pathInput.value = joinPath(categoryDir(settings, catSel.value), name);
      userPickedPath = false;
    });
    pathInput.addEventListener('input', () => (userPickedPath = true));
    browse.addEventListener('click', async () => {
      const p = await vdm.chooseSaveAs(pathInput.value);
      if (p) {
        pathInput.value = p;
        userPickedPath = true;
      }
    });

    async function probe() {
      const url = urlInput.value.trim();
      err.classList.add('hidden');
      if (!/^https?:\/\//i.test(url)) {
        meta.textContent = 'Enter an http:// or https:// address';
        return;
      }
      meta.textContent = 'Getting file information…';
      setName(request.fileName || nameFromUrl(url));
      try {
        info = await vdm.probe(url, {
          referer: request.referer,
          cookies: request.cookies,
          userAgent: request.userAgent,
          fileName: request.fileName,
          title: request.title,
          mime: request.mime,
          auth: authValue(),
        });
        if (url !== urlInput.value.trim()) return; // changed meanwhile
        setName(info.fileName, info.category);
        const parts = [];
        parts.push(info.size > 0 ? bytes(info.size) : info.type === 'hls' ? 'Video stream (HLS)' : 'Size unknown');
        if (info.type !== 'hls') parts.push(info.resumable ? 'Resume supported' : 'Resume NOT supported');
        if (info.type === 'hls' && !env.ffmpeg) parts.push('install ffmpeg to save as MP4');
        meta.textContent = parts.join(' · ');
        if (info.variants?.length) {
          variantSel.replaceChildren(...info.variants.map((v) => el('option', { value: v.url }, `${v.name} — ${Math.round(v.bandwidth / 1000)} kbps`)));
          showVariants(true);
        } else showVariants(false);
      } catch (e) {
        info = null;
        meta.textContent = '';
        err.textContent = `Could not get file information: ${cleanError(e)}. You can still try to download it.`;
        err.classList.remove('hidden');
      }
    }

    function authValue() {
      return authToggle.querySelector('input').checked && user.value ? { username: user.value, password: pass.value } : undefined;
    }

    function result(start) {
      const url = urlInput.value.trim();
      if (!/^https?:\/\//i.test(url)) {
        err.textContent = 'Please enter a valid http(s) address.';
        err.classList.remove('hidden');
        return null;
      }
      const { dir, name } = splitPath(pathInput.value.trim());
      return {
        url,
        fileName: name || undefined,
        saveDir: dir || undefined,
        category: catSel.value,
        description: desc.value,
        referer: request.referer,
        cookies: request.cookies,
        userAgent: request.userAgent,
        title: request.title,
        mime: info?.mime || request.mime,
        size: info?.size,
        type: info?.type,
        hlsVariant: !variantRow.classList.contains('hidden') ? variantSel.value : undefined,
        auth: authValue(),
        start,
        queueId: start ? null : queueSel.value,
      };
    }

    startBtn.addEventListener('click', () => {
      const r = result(true);
      if (r) onDone(r);
    });
    laterBtn.addEventListener('click', () => {
      const r = result(false);
      if (r) onDone(r);
    });
    cancelBtn.addEventListener('click', () => onDone(null));
    // Pasting a list of links: hand them to the multi-link picker when there is one.
    urlInput.addEventListener('paste', (e) => {
      const found = linksIn(e.clipboardData.getData('text'));
      if (found.length < 2) return;
      e.preventDefault();
      if (onMultiple) onMultiple(found);
      else {
        urlInput.value = found[0];
        probe();
      }
    });
    let t;
    urlInput.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(probe, 600);
    });

    const body = el(
      'div',
      { class: 'form' },
      el('label', {}, 'URL'), urlInput,
      el('label', {}, 'Category'), catSel,
      el('label', {}, 'Save As'), el('div', { class: 'row' }, pathInput, browse),
      el('label', {}, ''), meta,
      variantLabel, variantRow,
      el('label', {}, 'Description'), desc,
      el('label', {}, ''), authToggle,
      el('label', {}, ''), authRow,
      err
    );

    const foot = el('div', { class: 'dlg-foot' }, el('div', { class: 'left' }, laterBtn, queueSel), cancelBtn, startBtn);
    probe();
    return { body, foot, focus: () => startBtn.focus() };
  }

  /** Every distinct http(s) link in a block of text, in order (one per line, or mixed with prose). */
  function linksIn(text) {
    const found = String(text || '').match(/https?:\/\/[^\s"'<>]+/gi) || [];
    return [...new Set(found.map((u) => u.replace(/[.,;:!?]+$/, '')))];
  }

  function nameFromUrl(url) {
    try {
      const p = new URL(url).pathname.split('/').filter(Boolean).pop();
      return p ? decodeURIComponent(p) : 'download';
    } catch {
      return 'download';
    }
  }

  function cleanError(e) {
    return String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }

  window.U = { icon, el, bytes, speed, eta, date, percent, sizeText, statusText, fileIcon, isActive, drawSegments, CAT, categoryDir, categoryForName, splitPath, joinPath, newDownloadForm, nameFromUrl, linksIn, linkExpired, cleanError };

  // Apply platform class for platform-specific spacing (macOS traffic lights).
  vdm.env().then((env) => document.documentElement.classList.add(`platform-${env.platform}`));
})();
