'use strict';
/* Per-download progress window (IDM's progress dialog) and "Download complete" view. */
(async function () {
  const { el, icon } = U;
  const id = new URLSearchParams(location.search).get('id');
  const root = document.getElementById('root');
  let item = await vdm.get(id);
  let mode = null;
  let ui = null;
  if (!item) return vdm.closeWindow();

  function buildProgress() {
    mode = 'progress';
    const kv = el('div', { class: 'kv' });
    const fields = {};
    for (const [k, label] of [
      ['status', 'Status'],
      ['size', 'File size'],
      ['done', 'Downloaded'],
      ['rate', 'Transfer rate'],
      ['eta', 'Time left'],
      ['resume', 'Resume capability'],
    ]) {
      fields[k] = el('div');
      kv.append(el('div', {}, label), fields[k]);
    }
    const bar = el('div', { class: 'pbar big-bar' }, el('i'));
    const seg = el('canvas', { class: 'segbar', title: 'Each block is a part of the file downloaded by its own connection' });
    const connBody = el('tbody');
    const details = el(
      'div',
      { class: 'stack', style: { flex: 1, minHeight: 0, gap: '8px' } },
      seg,
      el('div', { class: 'conn-wrap' }, el('table', { class: 'conn-table' }, el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Range'), el('th', {}, 'Downloaded'), el('th', {}, 'Info'))), connBody))
    );
    const limitChk = el('input', { type: 'checkbox', checked: item.speedLimit > 0 });
    const limitVal = el('input', { type: 'number', min: 10, value: item.speedLimit || 500, style: { width: '84px' } });
    const applyLimit = () => vdm.update(id, { speedLimit: limitChk.checked ? Number(limitVal.value) || 0 : 0 });
    limitChk.addEventListener('change', applyLimit);
    limitVal.addEventListener('change', () => limitChk.checked && applyLimit());

    const toggleDetails = el('button', { class: 'btn sm', type: 'button' }, 'Hide details');
    toggleDetails.addEventListener('click', () => {
      const hide = !details.classList.contains('hidden');
      details.classList.toggle('hidden', hide);
      toggleDetails.textContent = hide ? 'Show details' : 'Hide details';
      window.resizeTo(window.outerWidth, hide ? 330 : 470);
    });
    const pauseBtn = el('button', { class: 'btn', type: 'button' });
    pauseBtn.addEventListener('click', () => (U.isActive(item) ? vdm.pause(id) : vdm.start(id)));
    const cancelBtn = el('button', { class: 'btn', type: 'button', onclick: () => cancel() }, 'Cancel');

    root.replaceChildren(
      el('div', { class: 'pw-head' }, U.fileIcon(item, true), el('div', { class: 't' }, el('div', { class: 'fn' }), el('div', { class: 'url' }, item.url))),
      kv,
      bar,
      details,
      el(
        'div',
        { class: 'pw-foot' },
        el('div', { class: 'left' }, toggleDetails, el('label', { class: 'chk small' }, limitChk, 'Limit to'), limitVal, el('span', { class: 'muted small' }, 'KB/s')),
        pauseBtn,
        cancelBtn
      )
    );
    ui = { fields, bar, seg, connBody, pauseBtn, fn: root.querySelector('.fn') };
  }

  async function cancel() {
    // IDM's Cancel stops the download; it stays in the list so it can resume later.
    if (U.isActive(item)) await vdm.pause(id);
    vdm.closeWindow();
  }

  function updateProgress() {
    const it = item;
    const p = U.percent(it);
    const active = U.isActive(it);
    ui.fn.textContent = it.fileName;
    const f = ui.fields;
    f.status.textContent =
      it.status === 'downloading' ? (it.lastError ? `Retrying… (${it.lastError})` : 'Receiving data…') :
      it.status === 'connecting' ? 'Connecting…' :
      it.status === 'finishing' ? (it.type === 'hls' ? 'Joining video segments…' : 'Finishing…') :
      it.status === 'failed' ? `Error: ${it.error || 'failed'}` :
      it.status === 'queued' ? 'Waiting in queue' : 'Paused';
    f.status.style.color = it.status === 'failed' ? 'var(--err)' : '';
    f.size.textContent = it.size > 0 ? (it.sizeEstimated ? '~' : '') + U.bytes(it.size) : 'Unknown';
    f.done.textContent = `${U.bytes(it.downloaded) || '0 B'}${p >= 0 ? ` (${p.toFixed(2)}%)` : ''}${it.type === 'hls' && it.duration ? ` · ${Math.round(it.duration / 60)} min video` : ''}`;
    f.rate.textContent = active ? U.speed(it.speed) || '—' : '—';
    f.eta.textContent = active ? U.eta(it.eta) || '—' : '—';
    f.resume.textContent = it.resumable == null ? '…' : it.resumable ? 'Yes' : 'No — pausing will restart the download';
    f.resume.style.color = it.resumable === false ? 'var(--warn)' : '';
    ui.bar.firstChild.style.width = `${Math.max(0, p)}%`;
    ui.bar.classList.toggle('indet', active && p < 0);
    ui.bar.classList.toggle('paused', !active);
    ui.pauseBtn.textContent = active ? 'Pause' : it.status === 'failed' ? 'Retry' : 'Resume';
    ui.pauseBtn.classList.toggle('primary', !active);
    U.drawSegments(ui.seg, it);

    const rows = it.type === 'hls'
      ? [el('tr', {}, el('td', {}, '—'), el('td', {}, `${Math.round((it.hlsProgress || 0) * 100)}% of segments`), el('td', {}, U.bytes(it.downloaded)), el('td', {}, `${it.connections} parallel connections${it.hlsVariant ? ` · ${it.hlsVariant}` : ''}`))]
      : (it.segments || []).map(([start, end, done, live], i) => {
          const len = end >= 0 ? end - start + 1 : -1;
          const complete = len > 0 && done >= len;
          return el(
            'tr',
            {},
            el('td', {}, i + 1),
            el('td', { class: 'mono' }, end >= 0 ? `${U.bytes(start)} – ${U.bytes(end + 1)}` : `${U.bytes(start)} – end`),
            el('td', {}, `${U.bytes(done) || '0 B'}${len > 0 ? ` (${Math.floor((done / len) * 100)}%)` : ''}`),
            el('td', { class: live ? '' : 'muted' }, complete ? 'Complete' : live ? 'Receiving data…' : active ? 'Waiting' : 'Paused')
          );
        });
    ui.connBody.replaceChildren(...rows);
    vdm.setTitle(`${p >= 0 ? `${Math.floor(p)}% ` : ''}${it.fileName}`);
  }

  function buildComplete() {
    mode = 'complete';
    const it = item;
    const secs = it.completedAt && it.lastTry ? (it.completedAt - it.lastTry) / 1000 : 0;
    root.replaceChildren(
      el('div', { class: 'done-hero' }, el('div', { class: 'ok-ring' }, icon('check')), el('div', {}, el('h2', {}, 'Download complete'), el('div', { class: 'muted' }, `${U.bytes(it.size)}${secs > 0 ? ` in ${U.eta(secs)} (avg ${U.speed(it.size / secs)})` : ''}`))),
      el('div', { class: 'kv' }, el('div', {}, 'Address'), el('div', { class: 'select-text', title: it.url }, it.url), el('div', {}, 'File'), el('div', {}, it.fileName)),
      el('div', { class: 'hint' }, 'The file was saved as:'),
      el('div', { class: 'path-box' }, it.savePath),
      el('div', { style: { flex: 1 } }),
      el(
        'div',
        { class: 'pw-foot' },
        el('div', { class: 'left' }),
        el('button', { class: 'btn', type: 'button', onclick: () => (vdm.showInFolder(id), vdm.closeWindow()) }, icon('folder'), 'Open Folder'),
        el('button', { class: 'btn', type: 'button', onclick: () => (vdm.openFile(id), vdm.closeWindow()) }, icon('open'), 'Open'),
        el('button', { class: 'btn primary', type: 'button', onclick: () => vdm.closeWindow() }, 'Close')
      )
    );
    vdm.setTitle('Download complete');
    window.resizeTo(window.outerWidth, 360);
  }

  function update() {
    if (item.status === 'completed') {
      if (mode !== 'complete') buildComplete();
      return;
    }
    if (mode !== 'progress') buildProgress();
    updateProgress();
  }

  vdm.on('changes', (list) => {
    const mine = list.find((x) => x.id === id);
    if (mine) {
      item = mine;
      update();
    }
  });
  vdm.on('removed', (rid) => rid === id && vdm.closeWindow());
  window.addEventListener('resize', () => mode === 'progress' && U.drawSegments(ui.seg, item));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && vdm.closeWindow());
  update();
})();
