(async function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const D = SAFE.DEFAULT_SETTINGS;
  const settings = { ...D, ...(await chrome.storage.local.get(Object.keys(D))) };
  // ?tab=<id> lets the popup be opened as a normal page for debugging/screenshots.
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  const [tab] = forced ? [{ id: forced }] : await chrome.tabs.query({ active: true, currentWindow: true });

  $('enabled').checked = settings.enabled;
  $('threshold').value = settings.threshold;
  $('thresholdOut').textContent = Number(settings.threshold).toFixed(2);
  $('debug').checked = settings.debug;
  $('blurPending').checked = settings.blurPending;
  $('backend').value = settings.backend;

  const save = (k, v) => chrome.storage.local.set({ [k]: v });
  $('enabled').onchange = e => save('enabled', e.target.checked);
  $('debug').onchange = e => save('debug', e.target.checked);
  $('blurPending').onchange = e => save('blurPending', e.target.checked);
  $('backend').onchange = e => save('backend', e.target.value);
  $('threshold').oninput = e => {
    const v = Number(e.target.value);
    $('thresholdOut').textContent = v.toFixed(2);
    save('threshold', v);
  };

  async function refresh() {
    if (tab) {
      const { total = {}, frames = 0 } = await chrome.runtime.sendMessage({ what: 'getTabStats', tabId: tab.id }) || {};
      $('scanned').textContent = total.scanned || 0;
      $('flagged').textContent = total.flagged || 0;
      $("pending").textContent = (total.pending || 0) + (total.waiting || 0);
      $('small').textContent = total.small || 0;
      $('detail').textContent =
        `via fetch ${total.viaFetch || 0} · via capture ${total.viaCapture || 0} · errors ${total.errors || 0}` +
        ` · revealed ${total.revealed || 0} · frames ${frames}`;
    }
    const st = await chrome.runtime.sendMessage({ what: 'getStatus' }).catch(() => null);
    $('model').textContent = !st || !st.running
      ? 'model: not loaded yet (loads on first image)'
      : st.error ? `model error: ${st.error}`
      : `${st.detector} on ${st.backend || '…'} · ${st.ready ? 'ready' : 'loading'} · ` +
        `${st.inferences} runs, avg ${st.avgInferMs}ms · queue ${st.queued} · cache ${st.cacheSize}`;
  }
  refresh();
  setInterval(refresh, 1000);
})();
