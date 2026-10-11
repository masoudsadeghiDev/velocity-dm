'use strict';
/* Main window: toolbar, categories/queues sidebar, download list. */
(async function () {
  const { el, icon } = U;
  const $ = (id) => document.getElementById(id);

  const state = {
    items: new Map(),
    queues: await vdm.queues(),
    settings: await vdm.settings(),
    env: await vdm.env(),
    view: 'all', // all | cat:<id> | unfinished | finished | queue:<id>
    sort: { key: 'addedAt', dir: -1 },
    selected: new Set(),
    anchor: null,
    filter: '',
    totals: { speed: 0, active: 0 },
    order: [],
  };
  for (const it of await vdm.list()) state.items.set(it.id, it);
  window.APP = state; // dialogs read settings/queues from here

  // ---------------------------------------------------------------- toolbar

  const currentQueueId = () => (state.view.startsWith('queue:') ? state.view.slice(6) : 'main');
  const queueById = (id) => state.queues.find((q) => q.id === id);

  const TOOLBAR = [
    { id: 'add', label: 'Add URL', icon: 'link', title: 'Add a new download (⌘N)', run: () => D.addUrl() },
    { id: 'resume', label: 'Resume', icon: 'play', run: () => resumeSel() },
    { id: 'resumeAll', label: 'Resume All', icon: 'resumeAll', title: 'Resume every stopped download (paste new links for expired ones)', run: () => resumeAll() },
    { id: 'stop', label: 'Stop', icon: 'stop', run: () => stopSel() },
    { id: 'stopAll', label: 'Stop All', icon: 'stopAll', run: () => vdm.pauseAll() },
    { id: 'delete', label: 'Delete', icon: 'trash', danger: true, run: () => deleteSel() },
    { id: 'deleteDone', label: 'Delete Done', icon: 'trashDone', title: 'Remove all completed downloads from the list', run: () => deleteCompleted() },
    'sep',
    { id: 'options', label: 'Options', icon: 'sliders', run: () => D.options() },
    { id: 'scheduler', label: 'Scheduler', icon: 'clock', run: () => D.scheduler(currentQueueId()) },
    { id: 'startQueue', label: 'Start Queue', icon: 'queuePlay', run: () => vdm.startQueue(currentQueueId()) },
    { id: 'stopQueue', label: 'Stop Queue', icon: 'queueStop', run: () => vdm.stopQueue(currentQueueId()) },
    'sep',
    { id: 'grabber', label: 'Grabber', icon: 'globe', title: 'Site Grabber: find and download files from a website', run: () => D.grabber() },
    { id: 'batch', label: 'Batch', icon: 'layers', title: 'Batch download: paste a list of links, or a file*.zip pattern', run: () => D.batch() },
    { id: 'limiter', label: 'Speed Limit', icon: 'gauge', run: () => vdm.setSettings({ speedLimitEnabled: !state.settings.speedLimitEnabled }) },
  ];
  const tbButtons = {};
  const toolbar = $('toolbar');
  for (const b of TOOLBAR) {
    if (b === 'sep') {
      toolbar.append(el('div', { class: 'tb-sep' }));
      continue;
    }
    const btn = el('button', { class: `tb-btn${b.danger ? ' danger' : ''}`, title: b.title || b.label, onclick: b.run }, icon(b.icon), b.label);
    tbButtons[b.id] = btn;
    toolbar.append(btn);
  }
  toolbar.append(el('div', { class: 'tb-spacer' }));
  const searchInput = el('input', { type: 'text', placeholder: 'Search downloads', spellcheck: false });
  searchInput.addEventListener('input', () => {
    state.filter = searchInput.value.trim().toLowerCase();
    render();
  });
  toolbar.append(el('label', { class: 'search' }, icon('search'), searchInput));

  function updateToolbar() {
    const sel = selectedItems();
    tbButtons.resume.disabled = !sel.some((i) => !U.isActive(i) && i.status !== 'completed');
    tbButtons.resumeAll.disabled = stuckItems().length === 0;
    tbButtons.stop.disabled = !sel.some((i) => U.isActive(i) || i.status === 'queued');
    tbButtons.delete.disabled = sel.length === 0;
    tbButtons.stopAll.disabled = state.totals.active === 0 && ![...state.items.values()].some((i) => i.status === 'queued');
    tbButtons.deleteDone.disabled = ![...state.items.values()].some((i) => i.status === 'completed');
    const q = queueById(currentQueueId());
    tbButtons.startQueue.disabled = !q || q.running;
    tbButtons.stopQueue.disabled = !q || !q.running;
    tbButtons.startQueue.title = `Start "${q?.name}"`;
    tbButtons.stopQueue.title = `Stop "${q?.name}"`;
    tbButtons.limiter.classList.toggle('on', !!state.settings.speedLimitEnabled);
    tbButtons.limiter.title = state.settings.speedLimitEnabled ? `Speed limiter ON (${state.settings.speedLimit} KB/s) — click to turn off` : 'Speed limiter is off — click to turn on';
  }

  // ---------------------------------------------------------------- sidebar

  function viewFilter(view) {
    if (view === 'all') return () => true;
    if (view === 'unfinished') return (i) => i.status !== 'completed';
    if (view === 'finished') return (i) => i.status === 'completed';
    if (view.startsWith('cat:')) {
      const c = view.slice(4);
      return (i) => i.category === c;
    }
    if (view.startsWith('queue:')) {
      const q = queueById(view.slice(6));
      const set = new Set(q?.items || []);
      return (i) => set.has(i.id);
    }
    return () => true;
  }

  function renderSidebar() {
    const items = [...state.items.values()];
    const count = (v) => items.filter(viewFilter(v)).length || '';
    const node = (view, label, ic, sub = false, extra = null) =>
      el(
        'div',
        {
          class: `side-item${sub ? ' sub' : ''}${state.view === view ? ' active' : ''}`,
          onclick: () => {
            state.view = view;
            state.selected.clear();
            renderSidebar();
            render();
          },
        },
        icon(ic),
        el('span', { class: 'ellipsis' }, label),
        extra,
        el('span', { class: 'count' }, count(view))
      );
    const cats = [...state.settings.categories, { id: 'general', name: 'General' }];
    $('sidebar').replaceChildren(
      el(
        'div',
        { class: 'side-group' },
        el('div', { class: 'side-title' }, 'Categories'),
        node('all', 'All Downloads', 'inbox'),
        cats.map((c) => node(`cat:${c.id}`, c.name, (U.CAT[c.id] || U.CAT.general).icon, true))
      ),
      el('div', { class: 'side-group' }, el('div', { class: 'side-title' }, 'Status'), node('unfinished', 'Unfinished', 'download'), node('finished', 'Finished', 'checkCircle')),
      el(
        'div',
        { class: 'side-group' },
        el('div', { class: 'side-title' }, 'Queues'),
        state.queues.map((q) => node(`queue:${q.id}`, q.name, 'list', false, q.running ? el('span', { class: 'dot', title: 'Running' }) : null))
      )
    );
  }

  // ---------------------------------------------------------------- list

  const COLS = [
    { key: 'fileName', label: 'File Name' },
    { key: 'size', label: 'Size', width: 84 },
    { key: 'status', label: 'Status', width: 172 },
    { key: 'eta', label: 'Time Left', width: 96 },
    { key: 'speed', label: 'Transfer Rate', width: 104 },
    { key: 'lastTry', label: 'Last Try', width: 124 },
    { key: 'description', label: 'Description', width: 120 },
  ];
  $('cols').replaceChildren(...COLS.map((c) => el('col', { style: c.width ? { width: `${c.width}px` } : {} })));

  function renderHead() {
    $('head').replaceChildren(
      ...COLS.map((c) =>
        el(
          'th',
          {
            onclick: () => {
              state.sort = { key: c.key, dir: state.sort.key === c.key ? -state.sort.dir : c.key === 'fileName' ? 1 : -1 };
              renderHead();
              render();
            },
          },
          c.label,
          state.sort.key === c.key ? el('span', { class: 'arrow' }, state.sort.dir > 0 ? '▲' : '▼') : null
        )
      )
    );
  }

  const STATUS_RANK = { downloading: 0, connecting: 1, finishing: 2, queued: 3, paused: 4, failed: 5, completed: 6 };
  function sortValue(it, key) {
    switch (key) {
      case 'fileName': return (it.fileName || '').toLowerCase();
      case 'size': return it.size;
      case 'status': return STATUS_RANK[it.status] * 1000 - U.percent(it);
      case 'eta': return it.eta >= 0 ? it.eta : Infinity;
      case 'speed': return it.speed || 0;
      case 'lastTry': return it.lastTry || 0;
      case 'description': return (it.description || '').toLowerCase();
      default: return it.addedAt || 0;
    }
  }

  function visibleItems() {
    const f = viewFilter(state.view);
    let list = [...state.items.values()].filter(f);
    if (state.filter) list = list.filter((i) => `${i.fileName} ${i.url} ${i.description}`.toLowerCase().includes(state.filter));
    if (state.view.startsWith('queue:')) {
      // Queues are shown in their processing order unless the user sorts.
      const order = queueById(state.view.slice(6))?.items || [];
      if (state.sort.key === 'addedAt') return order.map((id) => state.items.get(id)).filter((i) => i && list.includes(i));
    }
    const { key, dir } = state.sort;
    return list.sort((a, b) => {
      const x = sortValue(a, key);
      const y = sortValue(b, key);
      return (x < y ? -1 : x > y ? 1 : 0) * dir || (b.addedAt || 0) - (a.addedAt || 0);
    });
  }

  const rowCache = new Map();
  function rowFor(it) {
    let tr = rowCache.get(it.id);
    if (!tr) {
      const bar = el('div', { class: 'pbar' }, el('i'));
      tr = el(
        'tr',
        { dataset: { id: it.id } },
        el('td', {}, el('div', { class: 'name-cell' }, el('span', { class: 'fi' }), el('span', { class: 'nm' }))),
        el('td', { class: 'num' }),
        el('td', {}, el('div', { class: 'status-cell' }, bar, el('span', { class: 'pct' }))),
        el('td', { class: 'num' }),
        el('td', { class: 'num' }),
        el('td', { class: 'num muted' }),
        el('td', { class: 'muted' })
      );
      tr._c = tr.children;
      tr._bar = bar;
      rowCache.set(it.id, tr);
    }
    fillRow(tr, it);
    return tr;
  }

  function fillRow(tr, it) {
    const c = tr._c;
    const key = `${it.fileName}|${it.category}`;
    if (tr._key !== key) {
      tr._key = key;
      c[0].querySelector('.fi').replaceChildren(U.fileIcon(it));
      c[0].querySelector('.nm').textContent = it.fileName;
      c[0].title = `${it.fileName}\n${it.url}`;
    }
    c[1].textContent = U.sizeText(it);
    const p = U.percent(it);
    const bar = tr._bar;
    const active = U.isActive(it);
    bar.classList.toggle('hidden', !active && (it.status === 'completed' || it.downloaded <= 0));
    bar.classList.toggle('paused', !active);
    bar.classList.toggle('indet', active && p < 0);
    bar.firstChild.style.width = `${Math.max(0, p)}%`;
    const pct = c[2].querySelector('.pct');
    pct.textContent = U.statusText(it);
    pct.className = `pct st-${it.status === 'completed' ? 'complete' : U.linkExpired(it) ? 'failed' : it.status}`;
    pct.style.minWidth = bar.classList.contains('hidden') ? '0' : '';
    c[2].title = U.linkExpired(it)
      ? `${it.error || 'The download link has expired.'}\nUse “Resume All” to paste a new link.`
      : it.status === 'failed' ? it.error || 'Failed' : it.lastError && active ? `Retrying: ${it.lastError}` : '';
    c[3].textContent = active ? U.eta(it.eta) : '';
    c[4].textContent = active ? U.speed(it.speed) : '';
    c[5].textContent = U.date(it.lastTry || it.addedAt);
    c[6].textContent = it.description || '';
    tr.classList.toggle('sel', state.selected.has(it.id));
  }

  function render() {
    const list = visibleItems();
    const ids = list.map((i) => i.id);
    const tbody = $('rows');
    const same = ids.length === state.order.length && ids.every((id, i) => id === state.order[i]);
    if (same) {
      for (const it of list) fillRow(rowCache.get(it.id), it);
    } else {
      tbody.replaceChildren(...list.map(rowFor));
      state.order = ids;
    }
    for (const id of state.selected) if (!state.items.has(id)) state.selected.delete(id);
    renderEmpty(list.length === 0);
    renderBanner();
    updateToolbar();
    scheduleExpiryRender();
  }

  function renderEmpty(show) {
    const box = $('empty');
    box.classList.toggle('hidden', !show);
    if (!show) return;
    const filtered = state.filter || state.view !== 'all';
    box.replaceChildren(
      icon(filtered ? 'search' : 'download'),
      el('h3', {}, filtered ? 'Nothing here' : 'No downloads yet'),
      el(
        'div',
        { class: 'muted' },
        filtered ? 'No downloads match this view.' : 'Paste a link, drag one onto this window, or use the browser extension to capture downloads.'
      ),
      filtered ? null : el('button', { class: 'btn primary', onclick: () => D.addUrl() }, icon('link'), 'Add URL')
    );
  }

  // ---------------------------------------------------------------- selection & actions

  function selectedItems() {
    return [...state.selected].map((id) => state.items.get(id)).filter(Boolean);
  }

  $('rows').addEventListener('mousedown', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;
    if (e.button === 2 && state.selected.has(id)) return; // keep selection for context menu
    if (e.shiftKey && state.anchor) {
      const a = state.order.indexOf(state.anchor);
      const b = state.order.indexOf(id);
      state.selected = new Set(state.order.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (e.metaKey || e.ctrlKey) {
      state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
      state.anchor = id;
    } else {
      state.selected = new Set([id]);
      state.anchor = id;
    }
    render();
  });
  $('listWrap').addEventListener('mousedown', (e) => {
    if (!e.target.closest('tr') && !e.target.closest('button')) {
      state.selected.clear();
      render();
    }
  });
  $('rows').addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const it = state.items.get(tr.dataset.id);
    if (it.status === 'completed') vdm.openFile(it.id);
    else vdm.openProgress(it.id);
  });
  $('rows').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const tr = e.target.closest('tr');
    if (!tr) return;
    if (!state.selected.has(tr.dataset.id)) {
      state.selected = new Set([tr.dataset.id]);
      state.anchor = tr.dataset.id;
      render();
    }
    contextMenu(e.clientX, e.clientY);
  });

  function resumeSel() {
    for (const it of selectedItems()) if (!U.isActive(it) && it.status !== 'completed') vdm.start(it.id);
  }
  function stopSel() {
    for (const it of selectedItems()) vdm.pause(it.id);
  }
  async function deleteSel(withFiles = false) {
    const sel = selectedItems();
    if (!sel.length) return;
    const r = state.settings.confirmDelete || withFiles ? await D.confirmDelete(sel, withFiles) : { ok: true, deleteFiles: false };
    if (!r.ok) return;
    for (const it of sel) await vdm.remove(it.id, { deleteFile: r.deleteFiles });
  }
  async function deleteCompleted() {
    const done = [...state.items.values()].filter((i) => i.status === 'completed');
    if (!done.length) return;
    const r = await D.confirm(`Remove ${done.length} completed download${done.length > 1 ? 's' : ''} from the list?`, 'The downloaded files stay on disk.', 'Remove');
    if (r) for (const it of done) await vdm.remove(it.id, { deleteFile: false });
  }

  // ---------------------------------------------------------------- resume all / expired links

  function stuckItems() {
    return [...state.items.values()].filter((i) => i.status === 'paused' || i.status === 'failed');
  }

  function resumeAll() {
    const stuck = stuckItems();
    if (!stuck.length) return;
    // Dead links would just fail again: ask for fresh ones first.
    if (stuck.some(U.linkExpired)) D.refreshLinks(stuck);
    else vdm.resumeMany(stuck.map((i) => i.id), {});
  }

  // Links can expire while nothing else changes: redraw right when the next one does.
  let expiryTimer = null;
  function scheduleExpiryRender() {
    clearTimeout(expiryTimer);
    const now = Date.now();
    let next = Infinity;
    for (const i of state.items.values()) if (i.status !== 'completed' && i.linkExpiresAt > now) next = Math.min(next, i.linkExpiresAt);
    if (next !== Infinity) expiryTimer = setTimeout(render, Math.min(next - now + 250, 2 ** 31 - 1));
  }

  let bannerDismissed = '';
  function renderBanner() {
    const expired = stuckItems().filter(U.linkExpired);
    const key = expired.map((i) => i.id).sort().join(',');
    const box = $('banner');
    if (!expired.length || key === bannerDismissed) return box.classList.add('hidden');
    if (box._key === key && !box.classList.contains('hidden')) return;
    box._key = key;
    const n = expired.length;
    box.replaceChildren(
      icon('linkOff'),
      el('span', { class: 'msg' }, n === 1 ? `“${expired[0].fileName}” can't continue: its download link expired.` : `${n} downloads can't continue: their download links expired.`, ' Paste new links to resume from where they stopped.'),
      el('button', { class: 'btn sm primary', onclick: () => D.refreshLinks(stuckItems()) }, icon('resumeAll'), 'Paste New Links & Resume…'),
      el('button', { class: 'icon-btn', title: 'Hide', onclick: () => ((bannerDismissed = key), renderBanner()) }, icon('x'))
    );
    box.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- context menu

  let ctxEl = null;
  function closeCtx() {
    ctxEl?.remove();
    ctxEl = null;
  }
  document.addEventListener('mousedown', (e) => {
    if (ctxEl && !ctxEl.contains(e.target)) closeCtx();
  });
  window.addEventListener('blur', closeCtx);

  function contextMenu(x, y) {
    closeCtx();
    const sel = selectedItems();
    const one = sel.length === 1 ? sel[0] : null;
    const anyDone = sel.some((i) => i.status === 'completed');
    const mi = (label, ic, fn, { disabled = false, danger = false } = {}) =>
      el(
        'div',
        {
          class: `mi${disabled ? ' disabled' : ''}${danger ? ' danger' : ''}`,
          onclick: () => {
            if (disabled) return;
            closeCtx();
            fn();
          },
        },
        icon(ic),
        label
      );
    const sep = () => el('div', { class: 'sep' });
    const inQueue = one && one.queueId;
    ctxEl = el(
      'div',
      { class: 'ctx' },
      mi('Open', 'open', () => vdm.openFile(one.id), { disabled: !one || one.status !== 'completed' }),
      mi('Open Folder', 'folder', () => vdm.showInFolder(one.id), { disabled: !one }),
      mi('Show Progress', 'info', () => vdm.openProgress(one.id), { disabled: !one || one.status === 'completed' }),
      sep(),
      mi('Resume', 'play', resumeSel, { disabled: !sel.some((i) => !U.isActive(i) && i.status !== 'completed') }),
      mi('Stop', 'stop', stopSel, { disabled: !sel.some((i) => U.isActive(i) || i.status === 'queued') }),
      mi('Refresh Links & Resume…', 'resumeAll', () => D.refreshLinks(sel), { disabled: !sel.some((i) => i.status !== 'completed' && !U.isActive(i)) }),
      mi('Redownload', 'refresh', () => sel.forEach((i) => vdm.restart(i.id)), { disabled: !sel.length }),
      sep(),
      el('div', { class: 'lbl' }, 'Move to queue'),
      ...state.queues.map((q) => mi(q.name, 'list', () => sel.forEach((i) => vdm.moveToQueue(i.id, q.id)), { disabled: sel.every((i) => i.queueId === q.id) })),
      mi('Remove from queue', 'x', () => sel.forEach((i) => vdm.moveToQueue(i.id, null)), { disabled: !sel.some((i) => i.queueId) }),
      inQueue ? mi('Move Up in Queue', 'up', () => vdm.reorder(one.id, -1)) : null,
      inQueue ? mi('Move Down in Queue', 'down', () => vdm.reorder(one.id, 1)) : null,
      sep(),
      mi('Copy Address', 'copy', () => navigator.clipboard.writeText(sel.map((i) => i.url).join('\n'))),
      mi('Properties…', 'sliders', () => D.properties(one), { disabled: !one }),
      sep(),
      mi('Delete', 'trash', () => deleteSel(false), { danger: true }),
      anyDone ? mi('Delete with File', 'trash', () => deleteSel(true), { danger: true }) : null
    );
    document.body.append(ctxEl);
    const r = ctxEl.getBoundingClientRect();
    ctxEl.style.left = `${Math.min(x, innerWidth - r.width - 6)}px`;
    ctxEl.style.top = `${Math.min(y, innerHeight - r.height - 6)}px`;
  }

  // ---------------------------------------------------------------- keyboard, paste, drag & drop

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select, dialog')) return;
    if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey))) deleteSel();
    else if (e.key === 'Enter') {
      const it = selectedItems()[0];
      if (it) it.status === 'completed' ? vdm.openFile(it.id) : vdm.openProgress(it.id);
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault();
      state.selected = new Set(state.order);
      render();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const cur = state.order.indexOf(state.anchor);
      const next = state.order[Math.max(0, Math.min(state.order.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) {
        state.selected = new Set([next]);
        state.anchor = next;
        render();
        rowCache.get(next)?.scrollIntoView({ block: 'nearest' });
      }
    }
  });

  document.addEventListener('paste', (e) => {
    if (e.target.closest('input, textarea')) return;
    const urls = U.linksIn(e.clipboardData.getData('text'));
    if (urls.length === 1) D.addUrl(urls[0]);
    else if (urls.length > 1) D.links({ links: urls.map((url) => ({ url })) });
  });

  let dragDepth = 0;
  let overlay = null;
  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (dragDepth++ === 0) {
      overlay = el('div', { class: 'drop-overlay' }, 'Drop links to download');
      document.body.append(overlay);
    }
  });
  document.addEventListener('dragleave', () => {
    if (--dragDepth === 0) overlay?.remove();
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay?.remove();
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain') || '';
    const urls = U.linksIn(text);
    if (urls.length === 1) D.addUrl(urls[0]);
    else if (urls.length > 1) D.links({ links: urls.map((url) => ({ url })) });
  });

  // ---------------------------------------------------------------- status bar

  function renderStatus() {
    const t = state.totals;
    const s = state.settings;
    $('statusbar').replaceChildren(
      el('span', { class: 'sb' }, icon('download'), t.active ? `${U.speed(t.speed) || '0 B/s'} · ${t.active} active` : 'Idle'),
      el('span', { class: 'sb' }, `${state.items.size} downloads`),
      el(
        'span',
        { class: 'sb link', title: 'Toggle speed limiter', onclick: () => vdm.setSettings({ speedLimitEnabled: !s.speedLimitEnabled }) },
        icon('gauge'),
        s.speedLimitEnabled ? `Limit ${U.bytes(s.speedLimit * 1024)}/s` : 'No speed limit'
      ),
      el('span', { class: 'tb-spacer' }),
      el(
        'span',
        { class: 'sb link', title: 'Browser extension setup', onclick: () => D.extensionHelp() },
        el('span', { class: state.env.bridgeListening && s.browserIntegration ? 'dot-ok' : 'dot-off' }),
        s.browserIntegration ? (state.env.bridgeListening ? `Browser integration on :${s.bridgePort}` : 'Browser integration unavailable') : 'Browser integration off'
      ),
      el('span', { class: 'sb', title: state.env.ffmpeg ? 'ffmpeg found: HLS videos are saved as MP4' : 'Install ffmpeg to save HLS videos as MP4' }, icon('video'), state.env.ffmpeg ? 'ffmpeg ready' : 'no ffmpeg')
    );
  }

  // ---------------------------------------------------------------- live updates

  vdm.on('added', (it) => {
    state.items.set(it.id, it);
    vdm.queues().then((q) => {
      state.queues = q;
      renderSidebar();
      render();
    });
  });
  vdm.on('removed', (id) => {
    state.items.delete(id);
    state.selected.delete(id);
    rowCache.delete(id);
    renderSidebar();
    render();
  });
  let sidebarDirty = false;
  vdm.on('changes', (list) => {
    for (const it of list) {
      const prev = state.items.get(it.id);
      if (!prev || prev.status !== it.status || prev.category !== it.category || prev.queueId !== it.queueId) sidebarDirty = true;
      state.items.set(it.id, it);
    }
    if (sidebarDirty) {
      sidebarDirty = false;
      renderSidebar();
    }
    render();
  });
  vdm.on('queues', (q) => {
    state.queues = q;
    renderSidebar();
    render();
  });
  vdm.on('settings', (s) => {
    state.settings = s;
    vdm.env().then((env) => {
      state.env = env;
      renderStatus();
    });
    renderStatus();
    updateToolbar();
  });
  vdm.on('totals', (t) => {
    state.totals = t;
    renderStatus();
  });
  vdm.on('command', ({ name, payload }) => {
    const cmds = {
      'add-url': () => D.addUrl(payload),
      batch: () => D.batch(),
      'batch-clipboard': () => D.batchFromClipboard(),
      grabber: () => D.grabber(),
      options: () => D.options(),
      scheduler: () => D.scheduler(currentQueueId()),
      resume: resumeSel,
      'resume-all': resumeAll,
      'refresh-links': () => D.refreshLinks(stuckItems()),
      stop: stopSel,
      delete: () => deleteSel(),
      'delete-completed': deleteCompleted,
      links: () => D.links(payload),
      'extension-help': () => D.extensionHelp(),
    };
    cmds[name]?.();
  });

  renderHead();
  renderSidebar();
  render();
  renderStatus();
})();
