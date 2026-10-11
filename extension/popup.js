'use strict';
(async () => {
  const $ = (id) => document.getElementById(id);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const state = await chrome.runtime.sendMessage({ type: 'status', tabId: tab?.id });

  const status = $('status');
  if (state.info) {
    status.textContent = state.info.capture ? 'Connected' : 'Capture off in app';
    status.className = `status ${state.info.capture ? 'ok' : ''}`;
  } else {
    status.textContent = 'App not running';
    status.className = 'status err';
  }

  $('enabled').checked = state.prefs.enabled;
  $('enabled').addEventListener('change', (e) => chrome.runtime.sendMessage({ type: 'setPrefs', prefs: { enabled: e.target.checked } }));
  $('port').value = state.prefs.port;
  $('port').addEventListener('change', (e) => chrome.runtime.sendMessage({ type: 'setPrefs', prefs: { port: Number(e.target.value) || 9614 } }));
  $('allLinks').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'downloadPage', tabId: tab.id });
    window.close();
  });
  $('allLinks').disabled = !state.info;

  const box = $('media');
  if (!state.media.length) {
    box.innerHTML = '<div class="empty">No video or audio detected yet. Start playing a video on this page.</div>';
    return;
  }
  for (const e of state.media) {
    const row = document.createElement('div');
    row.className = 'm';
    const t = document.createElement('div');
    t.className = 't';
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = e.kind === 'hls' ? `Video stream${e.quality ? ` (${e.quality})` : ''}` : `${e.kind === 'audio' ? 'Audio' : 'Video'} ${e.mime ? `· ${e.mime.split('/')[1]}` : ''}`;
    const s = document.createElement('div');
    s.className = 's';
    s.textContent = [e.size ? `${(e.size / 1048576).toFixed(1)} MB` : '', e.duration ? `${Math.floor(e.duration / 60)}:${String(e.duration % 60).padStart(2, '0')}` : '', new URL(e.url).host].filter(Boolean).join(' · ');
    s.title = e.url;
    t.append(n, s);
    const b = document.createElement('button');
    b.className = 'btn primary';
    b.textContent = 'Download';
    b.disabled = !state.info;
    b.addEventListener('click', async () => {
      b.disabled = true;
      const r = await chrome.runtime.sendMessage({ type: 'downloadMedia', entry: e, tabId: tab.id });
      b.textContent = r?.ok ? 'Sent ✓' : 'Failed';
    });
    row.append(t, b);
    box.append(row);
  }
})();
