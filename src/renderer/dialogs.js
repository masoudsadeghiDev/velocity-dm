'use strict';
/* Modal dialogs of the main window. Exposed as window.D */
(function () {
  const { el, icon } = U;
  const app = () => window.APP;

  function modal({ title, body, foot, width = 560, onClose }) {
    const closeBtn = el('button', { class: 'icon-btn', type: 'button', title: 'Close' }, icon('x'));
    const dlg = el(
      'dialog',
      { style: { width: `${width}px` } },
      el('div', { class: 'dlg' }, el('div', { class: 'dlg-head' }, el('h2', {}, title), closeBtn), el('div', { class: 'dlg-body' }, body), foot || null)
    );
    // Clean up right away instead of waiting for the 'close' event, which Chromium
    // defers while the window is hidden. Esc still arrives via that event.
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      dlg.remove();
      onClose?.();
    };
    const close = () => {
      if (dlg.open) dlg.close();
      cleanup();
    };
    closeBtn.addEventListener('click', close);
    dlg.addEventListener('close', cleanup);
    document.body.append(dlg);
    dlg.showModal();
    return { dlg, close };
  }

  const foot = (...children) => el('div', { class: 'dlg-foot' }, ...children);
  const btn = (label, onclick, cls = '') => el('button', { class: `btn ${cls}`, type: 'button', onclick }, label);

  function confirm(message, detail, okLabel = 'OK', danger = false) {
    return new Promise((resolve) => {
      let result = false;
      const m = modal({
        title: message,
        width: 440,
        body: detail ? el('div', { class: 'muted' }, detail) : null,
        foot: foot(btn('Cancel', () => m.close()), btn(okLabel, () => ((result = true), m.close()), danger ? 'primary danger' : 'primary')),
        onClose: () => resolve(result),
      });
    });
  }

  function confirmDelete(items, withFiles) {
    return new Promise((resolve) => {
      let ok = false;
      const anyDone = items.some((i) => i.status === 'completed');
      const chk = el('input', { type: 'checkbox', checked: !!withFiles });
      const m = modal({
        title: items.length === 1 ? `Delete “${items[0].fileName}”?` : `Delete ${items.length} downloads?`,
        width: 460,
        body: el(
          'div',
          { class: 'stack' },
          el('div', { class: 'muted' }, 'Removes the download from the list and discards any partially downloaded data.'),
          anyDone ? el('label', { class: 'chk' }, chk, 'Also move the downloaded file(s) to the Trash') : null
        ),
        foot: foot(btn('Cancel', () => m.close()), btn('Delete', () => ((ok = true), m.close()), 'primary')),
        onClose: () => resolve({ ok, deleteFiles: ok && anyDone && chk.checked }),
      });
    });
  }

  // ---------------------------------------------------------------- add URL

  async function addUrl(prefill) {
    let url = typeof prefill === 'string' ? prefill : prefill?.url || '';
    if (!url) {
      const clip = await readClipboard();
      const found = U.linksIn(clip);
      if (found.length > 1) return pickLinks(found, 'the clipboard');
      if (found.length === 1 && clip.trim() === found[0]) url = found[0];
    }
    const { settings, queues, env } = app();
    let m;
    const form = U.newDownloadForm({
      request: { url, ...(typeof prefill === 'object' ? prefill : {}) },
      settings,
      queues,
      env,
      onMultiple: (found) => {
        m.close();
        pickLinks(found, 'the pasted text');
      },
      onDone: async (r) => {
        if (r) {
          try {
            await vdm.add(r);
          } catch (e) {
            return alert(U.cleanError(e));
          }
        }
        m.close();
      },
    });
    m = modal({ title: 'Add URL', width: 640, body: form.body, foot: form.foot });
    form.body.querySelector('input').focus();
  }

  async function readClipboard() {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return '';
    }
  }

  function pickLinks(urls, source) {
    linkPicker({ title: `Download ${urls.length} links`, links: urls.map((url) => ({ url })), intro: `Found in ${source}.` });
  }

  /** IDM's "Add batch download from clipboard". */
  async function batchFromClipboard() {
    const found = U.linksIn(await readClipboard());
    if (found.length > 1) return pickLinks(found, 'the clipboard');
    if (found.length === 1) return addUrl(found[0]);
    batch();
  }

  // ---------------------------------------------------------------- options

  function options(tab = 'general') {
    const s = structuredClone(app().settings);
    const env = app().env;
    const pages = {};
    const field = (label, control, hint) => [el('label', {}, label), hint ? el('div', { class: 'stack', style: { gap: '4px' } }, control, el('div', { class: 'hint' }, hint)) : control];
    const check = (key, label, obj = s) => {
      const i = el('input', { type: 'checkbox', checked: !!obj[key], onchange: (e) => (obj[key] = e.target.checked) });
      return el('label', { class: 'chk' }, i, label);
    };
    const text = (key, obj = s, attrs = {}) => el('input', { type: 'text', value: obj[key] ?? '', spellcheck: false, oninput: (e) => (obj[key] = e.target.value), ...attrs });
    const num = (key, obj = s, attrs = {}) => el('input', { type: 'number', value: obj[key] ?? 0, style: { width: '110px' }, oninput: (e) => (obj[key] = Number(e.target.value)), ...attrs });
    const select = (key, opts, obj = s) =>
      el('select', { onchange: (e) => (obj[key] = isNaN(Number(e.target.value)) ? e.target.value : Number(e.target.value)) }, opts.map(([v, l]) => el('option', { value: v, selected: String(obj[key]) === String(v) }, l)));
    const folderPicker = (obj, key, placeholder) => {
      const input = el('input', { type: 'text', value: obj[key] || '', placeholder: placeholder || '', oninput: (e) => (obj[key] = e.target.value) });
      return el(
        'div',
        { class: 'row' },
        input,
        btn('Browse…', async () => {
          const p = await vdm.chooseFolder(input.value || s.downloadDir);
          if (p) input.value = obj[key] = p;
        }, 'sm')
      );
    };

    pages.general = el(
      'div',
      { class: 'stack' },
      check('launchAtLogin', 'Launch Velocity DM when I log in'),
      check('startMinimized', 'Start minimized to the menu bar / tray'),
      check('showStartDialog', 'Show the "Download File Info" dialog before a captured download starts'),
      check('showProgressWindow', 'Show the progress window when a download starts'),
      check('showCompleteDialog', 'Show the "Download complete" window'),
      check('notifications', 'Show system notifications'),
      check('confirmDelete', 'Ask before deleting downloads'),
      el('div', { class: 'form', style: { marginTop: '8px' } }, field('Appearance', select('theme', [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']])))
    );

    pages.connection = el(
      'div',
      { class: 'form' },
      field('Max connections', select('maxConnections', [1, 2, 4, 6, 8, 12, 16, 24, 32].map((n) => [n, `${n} per download`])), 'More connections usually means faster downloads. Some servers limit this.'),
      field('Retries', num('maxRetries', s, { min: 0, max: 100 }), 'How many times a broken connection is retried before giving up.'),
      field('Timeout (sec)', num('timeout', s, { min: 5, max: 600 })),
      field('User-Agent', text('userAgent', s, { placeholder: 'Default browser user agent' })),
      el('div', { class: 'full', style: { height: '4px' } }),
      field('Proxy', check('enabled', 'Use an HTTP proxy', s.proxy)),
      field('Host', el('div', { class: 'row' }, text('host', s.proxy, { placeholder: 'proxy.example.com' }), num('port', s.proxy, { min: 1, max: 65535 }))),
      field('Login', el('div', { class: 'row' }, text('username', s.proxy, { placeholder: 'Username (optional)' }), el('input', { type: 'password', value: s.proxy.password || '', placeholder: 'Password', oninput: (e) => (s.proxy.password = e.target.value) })))
    );

    const catRows = s.categories.map((c) =>
      el(
        'div',
        { class: 'form', style: { gridTemplateColumns: '120px 1fr', marginBottom: '8px' } },
        el('label', {}, c.name),
        el(
          'div',
          { class: 'stack', style: { gap: '4px' } },
          folderPicker(c, 'dir', `Default (${U.categoryDir({ ...s, categories: s.categories.map((x) => ({ ...x, dir: '' })) }, c.id)})`),
          el('input', { type: 'text', value: c.exts.join(' '), title: 'File extensions', class: 'mono', oninput: (e) => (c.exts = e.target.value.split(/[\s,]+/).map((x) => x.toLowerCase().replace(/^\./, '')).filter(Boolean)) })
        )
      )
    );
    pages.saveto = el(
      'div',
      { class: 'stack' },
      el('div', { class: 'form' }, field('Download folder', folderPicker(s, 'downloadDir'))),
      check('useCategoryFolders', 'Save files into a sub-folder per category (Compressed, Documents, Music, …)'),
      el('div', { class: 'hint', style: { margin: '6px 0 2px' } }, 'Per-category folder (leave empty for the default) and the file extensions that belong to it:'),
      ...catRows
    );

    const extPath = el('div', { class: 'path-box mono' }, '…');
    vdm.extensionPath().then((p) => (extPath.textContent = p));
    pages.browser = el(
      'div',
      { class: 'stack' },
      check('browserIntegration', 'Enable browser integration (capture downloads from Chrome, Edge, Brave, Firefox)'),
      check('clipboardMonitor', 'Monitor the clipboard for downloadable links'),
      el('div', { class: 'form' }, field('Port', num('bridgePort', s, { min: 1024, max: 65535 }), 'The extension talks to the app on 127.0.0.1 at this port (default 9614).')),
      el('div', { class: 'hint' }, 'Automatically download files with these extensions (wildcards like r0* allowed):'),
      el('textarea', { rows: 4, class: 'mono', value: s.captureExts, oninput: (e) => (s.captureExts = e.target.value) }),
      el('div', { class: 'form' }, field('Min. size (KB)', num('captureMinSizeKB', s, { min: 0 }), 'Smaller files are left to the browser. 0 = capture all sizes.')),
      el('div', { class: 'hint' }, 'Extension folder (load it with “Load unpacked” in chrome://extensions):'),
      el('div', { class: 'row' }, extPath, btn('Show', () => vdm.revealExtension(), 'sm'))
    );

    pages.limiter = el(
      'div',
      { class: 'stack' },
      check('speedLimitEnabled', 'Limit the total download speed'),
      el('div', { class: 'form' }, field('Max speed', el('div', { class: 'row' }, num('speedLimit', s, { min: 10 }), el('span', { class: 'muted' }, 'KB/s')), 'Applies to all downloads together. Each download can also have its own limit in Properties.'))
    );

    pages.video = el(
      'div',
      { class: 'stack' },
      el('div', { class: env.ffmpeg ? 'info-box' : 'error-box' }, env.ffmpeg ? 'ffmpeg was found. Streaming videos (HLS/m3u8) can be saved as MP4.' : 'ffmpeg was not found. Streaming videos will be saved as .ts files (they play in VLC). Install ffmpeg (e.g. "brew install ffmpeg") to get MP4 files.'),
      check('remuxToMp4', 'Convert downloaded streams to MP4 (lossless remux, needs ffmpeg)')
    );

    const TABS = [
      ['general', 'General'],
      ['connection', 'Connection'],
      ['saveto', 'Save To'],
      ['browser', 'Browser & File Types'],
      ['limiter', 'Speed Limiter'],
      ['video', 'Video'],
    ];
    const tabBar = el('div', { class: 'tabs' });
    const body = el('div');
    const wraps = {};
    const show = (id) => {
      tabBar.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.id === id));
      Object.entries(wraps).forEach(([k, w]) => w.classList.toggle('active', k === id));
    };
    for (const [id, label] of TABS) {
      tabBar.append(el('button', { class: 'tab', type: 'button', dataset: { id }, onclick: () => show(id) }, label));
      // Wrapper owns visibility so the page keeps its own display (grid/flex).
      wraps[id] = el('div', { class: 'tab-page' }, pages[id]);
      body.append(wraps[id]);
    }
    const m = modal({
      title: 'Options',
      width: 680,
      body,
      foot: foot(
        btn('Cancel', () => m.close()),
        btn('Save', async () => {
          await vdm.setSettings(s);
          m.close();
        }, 'primary')
      ),
    });
    m.dlg.querySelector('.dlg-head').after(tabBar);
    body.style.minHeight = '400px';
    show(tab);
  }

  // ---------------------------------------------------------------- scheduler

  function scheduler(selectId = 'main') {
    let queues = app().queues.map((q) => structuredClone(q));
    let current = queues.find((q) => q.id === selectId) || queues[0];
    const left = el('div', { class: 'stack', style: { width: '200px', flex: 'none' } });
    const right = el('div', { class: 'stack', style: { flex: 1, minWidth: 0 } });
    const nextRun = el('div', { class: 'hint' });

    const items = () => app().items;

    function renderLeft() {
      left.replaceChildren(
        el(
          'div',
          { class: 'qlist', style: { height: '330px' } },
          queues.map((q) =>
            el(
              'div',
              {
                class: `q${q.id === current.id ? ' active' : ''}`,
                onclick: () => {
                  current = q;
                  renderLeft();
                  renderRight();
                },
              },
              icon('list'),
              el('span', { class: 'ellipsis', style: { flex: 1 } }, q.name),
              q.running ? el('span', { class: 'dot-ok', title: 'Running' }) : null
            )
          )
        ),
        el(
          'div',
          { class: 'row' },
          btn('New Queue', async () => {
            const q = await vdm.createQueue('New Queue');
            queues.push(structuredClone(q));
            current = queues[queues.length - 1];
            renderLeft();
            renderRight();
          }, 'sm'),
          btn('Delete', async () => {
            if (current.id === 'main') return;
            if (!(await confirm(`Delete queue “${current.name}”?`, 'Its downloads stay in the list.', 'Delete'))) return;
            await vdm.deleteQueue(current.id);
            queues = queues.filter((q) => q.id !== current.id);
            current = queues[0];
            renderLeft();
            renderRight();
          }, 'sm')
        )
      );
    }

    function renderRight() {
      const q = current;
      const sc = q.schedule;
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const days = el(
        'div',
        { class: 'days' },
        dayNames.map((d, i) =>
          el(
            'label',
            {},
            el('input', {
              type: 'checkbox',
              checked: sc.days.includes(i),
              onchange: (e) => (sc.days = e.target.checked ? [...new Set([...sc.days, i])] : sc.days.filter((x) => x !== i)),
            }),
            d
          )
        )
      );
      const onceRadio = el('input', { type: 'radio', name: 'freq', checked: !!sc.once, onchange: () => ((sc.once = true), days.classList.add('hidden')) });
      const dailyRadio = el('input', { type: 'radio', name: 'freq', checked: !sc.once, onchange: () => ((sc.once = false), days.classList.remove('hidden')) });
      if (sc.once) days.classList.add('hidden');

      const qItems = q.items.map((id) => items().get(id)).filter(Boolean);
      const fileList = el(
        'div',
        { class: 'qlist', style: { maxHeight: '140px' } },
        qItems.length
          ? qItems.map((it, idx) =>
              el(
                'div',
                { class: 'q' },
                U.fileIcon(it),
                el('span', { class: 'ellipsis', style: { flex: 1 } }, it.fileName),
                el('span', { class: 'muted small' }, U.statusText(it)),
                el('button', { class: 'icon-btn', title: 'Move up', disabled: idx === 0, onclick: () => move(it.id, -1) }, icon('up')),
                el('button', { class: 'icon-btn', title: 'Move down', disabled: idx === qItems.length - 1, onclick: () => move(it.id, 1) }, icon('down')),
                el('button', { class: 'icon-btn', title: 'Remove from queue', onclick: () => removeFrom(it.id) }, icon('x'))
              )
            )
          : el('div', { class: 'q muted' }, 'No files in this queue. Use “Download Later” or right-click → Move to queue.')
      );

      right.replaceChildren(
        el('div', { class: 'form', style: { gridTemplateColumns: '110px 1fr' } },
          el('label', {}, 'Queue name'), el('input', { type: 'text', value: q.name, disabled: q.id === 'main', oninput: (e) => (q.name = e.target.value) }),
          el('label', {}, 'At the same time'), el('div', { class: 'row' }, el('input', { type: 'number', min: 1, max: 20, value: q.maxConcurrent, style: { width: '80px', flex: 'none' }, oninput: (e) => (q.maxConcurrent = Number(e.target.value)) }), el('span', { class: 'muted' }, 'files download simultaneously'))
        ),
        el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: sc.enabled, onchange: (e) => (sc.enabled = e.target.checked) }), el('b', {}, 'Start download at'), el('input', { type: 'time', value: sc.startTime, onchange: (e) => (sc.startTime = e.target.value) })),
        el('div', { class: 'row', style: { paddingLeft: '22px', gap: '14px' } }, el('label', { class: 'chk' }, onceRadio, 'Once'), el('label', { class: 'chk' }, dailyRadio, 'On these days:')),
        el('div', { style: { paddingLeft: '22px' } }, days),
        el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: sc.stopEnabled, onchange: (e) => (sc.stopEnabled = e.target.checked) }), el('b', {}, 'Stop download at'), el('input', { type: 'time', value: sc.stopTime, onchange: (e) => (sc.stopTime = e.target.value) })),
        el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: sc.retryFailed, onchange: (e) => (sc.retryFailed = e.target.checked) }), 'Retry failed downloads', el('input', { type: 'number', min: 1, max: 20, value: sc.retryCount, style: { width: '64px' }, oninput: (e) => (sc.retryCount = Number(e.target.value)) }), 'times'),
        el('div', { class: 'row' }, el('span', {}, 'When the queue is done:'), el('select', { onchange: (e) => (sc.onComplete = e.target.value) }, [['none', 'Do nothing'], ['quit', 'Quit Velocity DM'], ['sleep', 'Put the computer to sleep'], ['shutdown', 'Shut down the computer']].map(([v, l]) => el('option', { value: v, selected: sc.onComplete === v }, l)))),
        nextRun,
        el('div', { class: 'side-title', style: { padding: '6px 0 0' } }, `Files in queue (${qItems.length})`),
        fileList
      );
      vdm.nextRun(q.id).then((t) => (nextRun.textContent = q.schedule.enabled && t ? `Next start: ${new Date(t).toLocaleString()}` : ''));
    }

    async function move(id, delta) {
      await vdm.reorder(id, delta);
      await refresh();
    }
    async function removeFrom(id) {
      await vdm.moveToQueue(id, null);
      await refresh();
    }
    async function refresh() {
      const fresh = await vdm.queues();
      for (const f of fresh) {
        const local = queues.find((q) => q.id === f.id);
        if (local) Object.assign(local, { items: f.items, running: f.running });
      }
      renderLeft();
      renderRight();
    }
    async function apply() {
      for (const q of queues) await vdm.updateQueue(q.id, { name: q.name, maxConcurrent: q.maxConcurrent, schedule: q.schedule });
    }

    renderLeft();
    renderRight();
    const off = vdm.on('queues', refresh);
    const m = modal({
      title: 'Scheduler',
      width: 760,
      body: el('div', { class: 'row', style: { alignItems: 'flex-start', gap: '16px' } }, left, right),
      foot: foot(
        el('div', { class: 'left' }, btn('Start Now', async () => (await apply(), vdm.startQueue(current.id))), btn('Stop', () => vdm.stopQueue(current.id))),
        btn('Close', () => m.close()),
        btn('Apply', async () => {
          await apply();
          m.close();
        }, 'primary')
      ),
      onClose: off,
    });
  }

  // ---------------------------------------------------------------- link picker (grabber results, browser "download all links", paste)

  function linkPicker({ title, links, referer, cookies, userAgent, intro }) {
    const rows = links.map((l) => ({ ...l, fileName: l.fileName || U.nameFromUrl(l.url), checked: true }));
    const filter = el('input', { type: 'text', placeholder: 'Filter: e.g. zip mp4 pdf or any text', spellcheck: false });
    const listBox = el('div', { class: 'checklist', style: { maxHeight: '340px' } });
    const countLbl = el('span', { class: 'muted small' });
    const allChk = el('input', { type: 'checkbox', checked: true });
    const queueSel = el('select', {}, app().queues.map((q) => el('option', { value: q.id }, q.name)));
    const queueOf = () => app().queues.find((q) => q.id === queueSel.value);
    const atOnce = el('input', { type: 'number', min: 1, max: 20, value: queueOf()?.maxConcurrent || 1, style: { width: '58px' }, title: 'How many of these files download at the same time' });
    queueSel.addEventListener('change', () => (atOnce.value = queueOf()?.maxConcurrent || 1));
    const folder = el('input', { type: 'text', placeholder: 'Default folder for each file type (Video, Music, …)', spellcheck: false });
    const browse = btn('Browse…', async () => {
      const p = await vdm.chooseFolder(folder.value || app().settings.downloadDir);
      if (p) folder.value = p;
    }, 'sm');

    const visible = () => {
      const terms = filter.value.toLowerCase().split(/[\s,]+/).filter(Boolean);
      if (!terms.length) return rows;
      return rows.filter((r) => terms.some((t) => r.fileName.toLowerCase().endsWith('.' + t.replace(/^\./, '')) || r.url.toLowerCase().includes(t) || (r.text || '').toLowerCase().includes(t)));
    };
    function render() {
      const vis = visible();
      listBox.replaceChildren(
        ...vis.map((r) =>
          el(
            'label',
            { class: 'ci' },
            el('input', { type: 'checkbox', checked: r.checked, onchange: (e) => ((r.checked = e.target.checked), updateCount()) }),
            el('div', { style: { minWidth: 0 } }, el('div', { class: 'n' }, r.fileName, r.text && r.text !== r.fileName ? el('span', { class: 'muted' }, `  — ${r.text}`) : null), el('div', { class: 'u' }, r.url))
          )
        )
      );
      updateCount();
    }
    function updateCount() {
      const vis = visible();
      const n = vis.filter((r) => r.checked).length;
      countLbl.textContent = `${n} of ${vis.length} selected`;
      allChk.checked = n === vis.length && n > 0;
    }
    allChk.addEventListener('change', () => {
      visible().forEach((r) => (r.checked = allChk.checked));
      render();
    });
    filter.addEventListener('input', render);

    async function addAll(startNow) {
      const chosen = visible().filter((r) => r.checked);
      if (!chosen.length) return;
      const queueId = queueSel.value;
      const n = Math.max(1, Math.min(20, Number(atOnce.value) || 1));
      if (n !== queueOf()?.maxConcurrent) await vdm.updateQueue(queueId, { maxConcurrent: n });
      const saveDir = folder.value.trim() || undefined;
      for (const r of chosen) {
        try {
          await vdm.add({ url: r.url, referer: r.referer || referer, cookies: r.cookies || cookies, userAgent, queueId, saveDir, start: false });
        } catch {}
      }
      if (startNow) await vdm.startQueue(queueId);
      m.close();
    }

    render();
    const m = modal({
      title,
      width: 720,
      body: el(
        'div',
        { class: 'stack' },
        intro ? el('div', { class: 'muted' }, intro) : null,
        el('div', { class: 'row' }, el('label', { class: 'chk' }, allChk, 'All'), filter, countLbl),
        listBox,
        el('div', { class: 'row' }, el('span', { class: 'muted', style: { flex: 'none' } }, 'Save to'), folder, browse)
      ),
      foot: foot(
        el('div', { class: 'left' }, el('span', { class: 'muted' }, 'Queue'), queueSel, atOnce, el('span', { class: 'muted' }, 'at a time')),
        btn('Cancel', () => m.close()),
        btn('Add to Queue', () => addAll(false)),
        btn('Download Now', () => addAll(true), 'primary')
      ),
    });
  }

  function links(payload) {
    const list = (payload?.links || []).filter((l) => /^https?:/i.test(l.url));
    if (!list.length) return;
    linkPicker({
      title: `Download links (${list.length})`,
      links: list,
      referer: payload.referer,
      cookies: payload.cookies,
      userAgent: payload.userAgent,
      intro: payload.pageTitle ? `From “${payload.pageTitle}”` : null,
    });
  }

  // ---------------------------------------------------------------- site grabber

  function grabber() {
    const PRESETS = {
      'All files': '',
      Images: 'jpg jpeg png gif webp svg bmp tif tiff',
      Audio: 'mp3 m4a aac flac wav ogg opus wma',
      Video: 'mp4 mkv webm avi mov wmv flv m4v',
      Documents: 'pdf doc docx xls xlsx ppt pptx txt epub csv',
      Archives: 'zip rar 7z gz tar bz2 xz iso dmg exe msi',
    };
    const url = el('input', { type: 'url', placeholder: 'https://example.com/downloads/', spellcheck: false });
    const exts = el('input', { type: 'text', class: 'mono', value: PRESETS.Archives, spellcheck: false });
    const preset = el('select', { onchange: (e) => (exts.value = PRESETS[e.target.value]) }, Object.keys(PRESETS).map((k) => el('option', { selected: k === 'Archives' }, k)));
    const depth = el('select', {}, [0, 1, 2, 3, 4].map((d) => el('option', { value: d, selected: d === 1 }, d === 0 ? 'Only this page' : `${d} level${d > 1 ? 's' : ''} deep`)));
    const sameHost = el('input', { type: 'checkbox', checked: true });
    const maxPages = el('input', { type: 'number', value: 200, min: 1, max: 5000, style: { width: '100px' } });
    const progress = el('div', { class: 'muted small' });
    const err = el('div', { class: 'error-box hidden' });
    const startBtn = btn('Start', run, 'primary');
    navigator.clipboard.readText().then((t) => /^https?:\/\/\S+$/i.test(t.trim()) && !url.value && (url.value = t.trim())).catch(() => {});

    let off = null;
    async function run() {
      err.classList.add('hidden');
      if (!/^https?:\/\//i.test(url.value.trim())) {
        err.textContent = 'Enter the address of a web page to scan.';
        return err.classList.remove('hidden');
      }
      startBtn.disabled = true;
      progress.textContent = 'Starting…';
      off = vdm.on('grab-progress', (p) => (progress.textContent = `Scanned ${p.pages} page(s), found ${p.files} file(s)${p.current ? ` — ${p.current}` : ''}`));
      try {
        const results = await vdm.grab({
          startUrl: url.value.trim(),
          depth: Number(depth.value),
          sameHost: sameHost.checked,
          exts: exts.value.split(/[\s,]+/).filter(Boolean),
          maxPages: Number(maxPages.value) || 200,
        });
        off?.();
        if (!results.length) {
          progress.textContent = 'No matching files were found. Try more depth or other file types.';
          startBtn.disabled = false;
          return;
        }
        m.close();
        linkPicker({ title: `Site Grabber — ${results.length} files found`, links: results.map((r) => ({ url: r.url, fileName: r.fileName })), referer: url.value.trim() });
      } catch (e) {
        off?.();
        startBtn.disabled = false;
        err.textContent = U.cleanError(e);
        err.classList.remove('hidden');
      }
    }

    const m = modal({
      title: 'Site Grabber',
      width: 620,
      body: el(
        'div',
        { class: 'stack' },
        el('div', { class: 'muted' }, 'Scans a website and lists every file of the chosen types so you can download them all at once.'),
        el('div', { class: 'form' },
          el('label', {}, 'Start page'), url,
          el('label', {}, 'File types'), el('div', { class: 'row' }, preset, exts),
          el('label', {}, 'Explore'), el('div', { class: 'row' }, depth, el('label', { class: 'chk' }, sameHost, 'Stay on this website')),
          el('label', {}, 'Max pages'), maxPages
        ),
        progress,
        err
      ),
      foot: foot(btn('Cancel', () => m.close()), startBtn),
      onClose: () => {
        off?.();
        vdm.cancelGrab();
      },
    });
    url.focus();
  }

  // ---------------------------------------------------------------- batch

  async function batch() {
    // Mode 1: a pasted list of links (one per line, or any text containing links).
    const listBox = el('textarea', { rows: 9, class: 'mono', spellcheck: false, placeholder: 'Paste links here, one per line:\nhttps://example.com/show/S01E01.mkv\nhttps://example.com/show/S01E02.mkv' });
    const listCount = el('div', { class: 'hint' });
    const updateList = () => {
      const n = U.linksIn(listBox.value).length;
      listCount.textContent = n ? `${n} link${n > 1 ? 's' : ''} found` : 'No links yet';
    };
    listBox.addEventListener('input', updateList);
    const clip = await readClipboard();
    if (U.linksIn(clip).length) listBox.value = clip.trim();
    updateList();

    // Mode 2: IDM-style pattern, e.g. img*.jpg from 1 to 100.
    const tpl = el('input', { type: 'url', placeholder: 'https://example.com/photos/img*.jpg', spellcheck: false });
    const from = el('input', { type: 'text', value: '1', style: { width: '80px' } });
    const to = el('input', { type: 'text', value: '10', style: { width: '80px' } });
    const width = el('input', { type: 'number', value: 0, min: 0, max: 10, style: { width: '70px' } });
    const preview = el('div', { class: 'path-box mono', style: { minHeight: '64px', whiteSpace: 'pre' } });
    const err = el('div', { class: 'error-box hidden' });
    let list = [];
    async function update() {
      err.classList.add('hidden');
      try {
        list = await vdm.expandBatch(tpl.value.trim(), /^\d+$/.test(from.value) ? Number(from.value) : from.value, /^\d+$/.test(to.value) ? Number(to.value) : to.value, Number(width.value) || 0);
        preview.textContent = list.length <= 4 ? list.join('\n') : `${list.slice(0, 2).join('\n')}\n   … ${list.length - 3} more …\n${list[list.length - 1]}`;
      } catch (e) {
        list = [];
        preview.textContent = '';
        if (tpl.value.trim()) {
          err.textContent = U.cleanError(e);
          err.classList.remove('hidden');
        }
      }
    }
    [tpl, from, to, width].forEach((i) => i.addEventListener('input', update));

    const pages = {
      list: el('div', { class: 'stack' }, el('div', { class: 'muted' }, 'Paste any number of download links — each one becomes a separate download.'), listBox, listCount),
      pattern: el(
        'div',
        { class: 'stack' },
        el('div', { class: 'muted' }, 'Use * in the address as a wildcard. It is replaced by every number (or letter) in the range.'),
        el('div', { class: 'form' },
          el('label', {}, 'Address'), tpl,
          el('label', {}, 'Replace * with'), el('div', { class: 'row' }, el('span', {}, 'from'), from, el('span', {}, 'to'), to, el('span', {}, 'width'), width, el('span', { class: 'hint' }, '0 = no zero-padding')),
        ),
        el('div', { class: 'hint' }, 'Preview'),
        preview,
        err
      ),
    };
    let mode = 'list';
    const tabBar = el('div', { class: 'tabs' });
    const wraps = {};
    const show = (id) => {
      mode = id;
      tabBar.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.id === id));
      Object.entries(wraps).forEach(([k, w]) => w.classList.toggle('active', k === id));
      (id === 'list' ? listBox : tpl).focus();
    };
    const body = el('div');
    for (const [id, label] of [['list', 'List of links'], ['pattern', 'Pattern (*)']]) {
      tabBar.append(el('button', { class: 'tab', type: 'button', dataset: { id }, onclick: () => show(id) }, label));
      wraps[id] = el('div', { class: 'tab-page' }, pages[id]);
      body.append(wraps[id]);
    }

    const m = modal({
      title: 'Add Batch Download',
      width: 680,
      body,
      foot: foot(
        btn('Cancel', () => m.close()),
        btn('Review & Add…', () => {
          const urls = mode === 'list' ? U.linksIn(listBox.value) : list;
          if (!urls.length) return;
          m.close();
          linkPicker({ title: `Batch download — ${urls.length} file${urls.length > 1 ? 's' : ''}`, links: urls.map((url) => ({ url })) });
        }, 'primary')
      ),
    });
    m.dlg.querySelector('.dlg-head').after(tabBar);
    show('list');
  }

  // ---------------------------------------------------------------- refresh expired links & resume all

  function expiryNote(it) {
    if (it.linkExpiresAt > 0) {
      const when = new Date(it.linkExpiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
      return it.linkExpiresAt < Date.now() ? `Link expired ${when}` : `Link valid until ${when}`;
    }
    return it.status === 'failed' ? it.error || 'Failed' : U.statusText(it);
  }

  /**
   * Resume many stopped downloads at once. Paste fresh links for the ones whose links
   * expired; they are matched by file name and each download continues where it stopped.
   */
  async function refreshLinks(items) {
    const rows = items
      .filter((it) => it.status !== 'completed' && !U.isActive(it))
      .sort((a, b) => Number(U.linkExpired(b)) - Number(U.linkExpired(a)) || a.fileName.localeCompare(b.fileName))
      .map((it) => ({ it, checked: true, url: null, manual: false }));
    if (!rows.length) return;
    const expiredCount = rows.filter((r) => U.linkExpired(r.it)).length;

    const paste = el('textarea', { rows: 4, class: 'mono', spellcheck: false, placeholder: 'Paste the new links here (one per line). Get them from the same page you got the old ones.' });
    const listBox = el('div', { class: 'checklist', style: { maxHeight: '300px' } });
    const summary = el('div', { class: 'hint' });
    const resumeBtn = btn('Resume', () => go(), 'primary');
    let pasted = [];

    async function rematch() {
      pasted = U.linksIn(paste.value);
      const found = pasted.length ? await vdm.matchLinks(rows.map((r) => r.it.id), pasted) : {};
      for (const r of rows) {
        if (r.manual && pasted.includes(r.url)) continue;
        r.manual = false;
        r.url = found[r.it.id] || null;
      }
      render();
    }

    function render() {
      listBox.replaceChildren(
        ...rows.map((r) => {
          const expired = U.linkExpired(r.it);
          const chk = el('input', { type: 'checkbox', checked: r.checked, onchange: (e) => ((r.checked = e.target.checked), renderSummary()) });
          const pick = el(
            'select',
            {
              title: 'Which pasted link belongs to this download',
              disabled: !pasted.length,
              onchange: (e) => {
                r.url = e.target.value || null;
                r.manual = true;
                render();
              },
            },
            el('option', { value: '' }, pasted.length ? 'Keep current link' : 'Paste new links above'),
            pasted.map((u) => el('option', { value: u, selected: u === r.url }, U.nameFromUrl(u)))
          );
          const tag = r.url
            ? el('span', { class: 'tag ok-text' }, '✓ New link')
            : expired
              ? el('span', { class: 'tag st-failed' }, 'Needs new link')
              : el('span', { class: 'tag muted' }, `${Math.floor(Math.max(0, U.percent(r.it)))}% done`);
          return el(
            'div',
            { class: 'ci refresh-row' },
            chk,
            el('div', { style: { minWidth: 0 } }, el('div', { class: 'n', title: r.it.fileName }, r.it.fileName), el('div', { class: 'u', title: r.it.url }, expiryNote(r.it))),
            tag,
            pick
          );
        })
      );
      renderSummary();
    }

    function renderSummary() {
      const chosen = rows.filter((r) => r.checked);
      const fixed = chosen.filter((r) => r.url).length;
      const stillDead = chosen.filter((r) => !r.url && U.linkExpired(r.it)).length;
      summary.textContent = [
        pasted.length ? `${fixed} of ${chosen.length} matched with a new link` : null,
        stillDead ? `${stillDead} still ${stillDead === 1 ? 'needs' : 'need'} a new link and will likely fail again` : null,
      ].filter(Boolean).join(' · ');
      summary.style.color = stillDead ? 'var(--warn)' : '';
      resumeBtn.textContent = `Resume ${chosen.length === rows.length ? 'All ' : ''}(${chosen.length})`;
      resumeBtn.disabled = !chosen.length;
    }

    async function go() {
      const chosen = rows.filter((r) => r.checked);
      const urls = Object.fromEntries(chosen.filter((r) => r.url).map((r) => [r.it.id, r.url]));
      await vdm.resumeMany(chosen.map((r) => r.it.id), urls);
      m.close();
    }

    let t;
    paste.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(rematch, 250);
    });

    const m = modal({
      title: expiredCount ? 'Refresh Links & Resume' : 'Resume Downloads',
      width: 760,
      body: el(
        'div',
        { class: 'stack' },
        el(
          'div',
          { class: 'muted' },
          expiredCount
            ? `${expiredCount} download${expiredCount > 1 ? 's' : ''} stopped because ${expiredCount > 1 ? 'their links' : 'its link'} expired. Paste the new links — they are matched to your downloads by file name, and each download continues from where it stopped.`
            : 'These downloads are stopped. Paste new links for any whose address changed, or just resume them.'
        ),
        paste,
        listBox,
        summary
      ),
      foot: foot(btn('Cancel', () => m.close()), resumeBtn),
    });

    const clip = await readClipboard();
    if (U.linksIn(clip).length) paste.value = clip.trim();
    await rematch();
    paste.focus();
  }

  // ---------------------------------------------------------------- properties

  function properties(item) {
    if (!item) return;
    const p = {
      url: item.url,
      fileName: item.fileName,
      description: item.description,
      referer: item.referer,
      maxConnections: item.maxConnections || '',
      speedLimit: item.speedLimit || 0,
      username: item.auth?.username || '',
      password: '',
    };
    const canRename = item.downloaded === 0 && item.status !== 'completed' && !U.isActive(item);
    const inp = (key, attrs = {}) => el('input', { type: 'text', value: p[key] ?? '', spellcheck: false, oninput: (e) => (p[key] = e.target.value), ...attrs });
    const hashOut = el('div', { class: 'path-box mono', style: { minHeight: '34px' } });
    const hashCmp = el('input', { type: 'text', placeholder: 'Paste the expected checksum to compare', class: 'mono' });
    const algo = el('select', {}, ['md5', 'sha1', 'sha256', 'sha512'].map((a) => el('option', { value: a, selected: a === 'sha256' }, a.toUpperCase())));
    let lastHash = '';
    const compare = () => {
      const want = hashCmp.value.trim().toLowerCase();
      if (!want || !lastHash) return;
      hashOut.style.color = want === lastHash ? 'var(--ok)' : 'var(--err)';
      hashOut.textContent = `${lastHash}\n${want === lastHash ? '✓ Checksum matches' : '✗ Checksum does NOT match'}`;
    };
    hashCmp.addEventListener('input', compare);

    const body = el(
      'div',
      { class: 'stack' },
      el('div', { class: 'row', style: { gap: '12px' } }, U.fileIcon(item, true), el('div', { style: { minWidth: 0 } }, el('div', { class: 'ellipsis', style: { fontWeight: 600 } }, item.fileName), el('div', { class: 'muted small' }, `${U.sizeText(item) || 'Unknown size'} · ${U.statusText(item)} · resume ${item.resumable ? 'supported' : item.resumable === false ? 'not supported' : 'unknown'}`))),
      el('div', { class: 'form' },
        el('label', {}, 'Address'),
        el('div', { class: 'stack', style: { gap: '4px' } }, inp('url', { title: 'Change this to refresh an expired download link' }), item.linkExpiresAt ? el('div', { class: 'hint', style: { color: U.linkExpired(item) ? 'var(--err)' : '' } }, `${expiryNote(item)}${U.linkExpired(item) ? ' — paste a new link here to continue' : ''}`) : null),
        el('label', {}, 'File name'), inp('fileName', { disabled: !canRename, title: canRename ? '' : 'The name is fixed once the download has started' }),
        el('label', {}, 'Saved to'), el('div', { class: 'row' }, el('div', { class: 'path-box', style: { flex: 1 } }, item.savePath), btn('Open Folder', () => vdm.showInFolder(item.id), 'sm')),
        el('label', {}, 'Referer'), inp('referer'),
        el('label', {}, 'Description'), inp('description'),
        el('label', {}, 'Connections'), el('select', { onchange: (e) => (p.maxConnections = e.target.value) }, [['', 'Default'], ...[1, 2, 4, 8, 16, 24, 32].map((n) => [n, String(n)])].map(([v, l]) => el('option', { value: v, selected: String(p.maxConnections) === String(v) }, l))),
        el('label', {}, 'Speed limit'), el('div', { class: 'row' }, el('input', { type: 'number', min: 0, value: p.speedLimit, style: { width: '110px', flex: 'none' }, oninput: (e) => (p.speedLimit = Number(e.target.value)) }), el('span', { class: 'muted' }, 'KB/s (0 = unlimited)')),
        el('label', {}, 'Login'), el('div', { class: 'row' }, inp('username', { placeholder: 'Username' }), el('input', { type: 'password', placeholder: item.auth ? '(unchanged)' : 'Password', oninput: (e) => (p.password = e.target.value) })),
        el('label', {}, 'Added'), el('div', { class: 'muted' }, new Date(item.addedAt).toLocaleString(), item.completedAt ? ` · completed ${new Date(item.completedAt).toLocaleString()}` : '')
      ),
      item.status === 'completed'
        ? el(
            'div',
            { class: 'stack' },
            el('div', { class: 'side-title', style: { padding: '6px 0 0' } }, 'Verify file'),
            el('div', { class: 'row' }, algo, btn('Compute checksum', async () => {
              hashOut.style.color = '';
              hashOut.textContent = 'Computing…';
              try {
                lastHash = await vdm.checksum(item.id, algo.value);
                hashOut.textContent = lastHash;
                compare();
              } catch (e) {
                hashOut.textContent = U.cleanError(e);
              }
            }, 'sm'), hashCmp),
            hashOut
          )
        : null,
      item.error ? el('div', { class: 'error-box' }, item.error) : null
    );

    const m = modal({
      title: 'Properties',
      width: 640,
      body,
      foot: foot(
        btn('Cancel', () => m.close()),
        btn('Save', async () => {
          const patch = { url: p.url.trim(), description: p.description, referer: p.referer, maxConnections: p.maxConnections, speedLimit: p.speedLimit };
          if (canRename && p.fileName !== item.fileName) patch.fileName = p.fileName;
          if (p.username !== (item.auth?.username || '') || p.password) patch.auth = p.username ? { username: p.username, password: p.password } : null;
          await vdm.update(item.id, patch);
          m.close();
        }, 'primary')
      ),
    });
  }

  // ---------------------------------------------------------------- browser extension help

  async function extensionHelp() {
    const p = await vdm.extensionPath();
    const env = await vdm.env();
    const s = app().settings;
    const m = modal({
      title: 'Browser Integration',
      width: 600,
      body: el(
        'div',
        { class: 'stack' },
        el('div', { class: env.bridgeListening && s.browserIntegration ? 'info-box' : 'error-box' }, env.bridgeListening && s.browserIntegration ? `The app is listening for the extension on 127.0.0.1:${s.bridgePort}.` : 'Browser integration is off or the port is busy. Enable it in Options → Browser.'),
        el('b', {}, 'Install the extension (Chrome, Edge, Brave, Opera, Vivaldi)'),
        el('ol', { style: { margin: 0, paddingLeft: '20px', lineHeight: 1.8 } },
          el('li', {}, 'Open ', el('span', { class: 'mono' }, 'chrome://extensions'), ' in your browser'),
          el('li', {}, 'Turn on ', el('b', {}, 'Developer mode'), ' (top right)'),
          el('li', {}, 'Click ', el('b', {}, 'Load unpacked'), ' and choose this folder:'),
        ),
        el('div', { class: 'row' }, el('div', { class: 'path-box mono', style: { flex: 1 } }, p), btn('Show in Finder', () => vdm.revealExtension(), 'sm')),
        el('div', { class: 'muted' }, 'Then: downloads of the file types in Options are taken over automatically, right-click any link → “Download with Velocity DM”, and a download button appears on web videos.'),
        el('b', {}, 'Firefox'),
        el('div', { class: 'muted' }, 'Open about:debugging → This Firefox → Load Temporary Add-on… and select manifest.json in the same folder.')
      ),
      foot: foot(btn('Close', () => m.close(), 'primary')),
    });
  }

  window.D = { modal, confirm, confirmDelete, addUrl, options, scheduler, grabber, links, linkPicker, batch, batchFromClipboard, refreshLinks, properties, extensionHelp };
})();
