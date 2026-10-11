'use strict';
/* Standalone "Download File Info" window for links captured from the browser or clipboard. */
(async function () {
  const { el } = U;
  const token = new URLSearchParams(location.search).get('token');
  const request = (await vdm.takeRequest(token)) || {};
  const [settings, queues, env] = await Promise.all([vdm.settings(), vdm.queues(), vdm.env()]);
  const root = document.getElementById('root');

  const form = U.newDownloadForm({
    request,
    settings,
    queues,
    env,
    onDone: async (r) => {
      if (r) {
        try {
          await vdm.add(r);
        } catch (e) {
          alert(U.cleanError(e));
          return;
        }
      }
      vdm.closeWindow();
    },
  });

  const source = request.source === 'clipboard' ? 'Link copied to the clipboard' : request.pageUrl ? `From ${hostOf(request.pageUrl)}` : null;
  root.append(el('div', { class: 'dlg-body' }, source ? el('div', { class: 'hint', style: { marginBottom: '10px' } }, source) : null, form.body), form.foot);
  form.focus();
  document.addEventListener('keydown', (e) => e.key === 'Escape' && vdm.closeWindow());

  function hostOf(u) {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  }
})();
