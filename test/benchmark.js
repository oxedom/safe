// Injected via CDP before navigation. Collect image load/scan timings without
// exporting image URLs or page content. This is test instrumentation only.
(() => {
  const records = [];
  const current = new WeakMap();
  const loaded = new WeakMap();
  performance.setResourceTimingBufferSize(10000);
  function onLoad(event) {
    const img = event.target;
    if (img.localName !== 'img') { return; }
    const load = { at: performance.now(), url: img.currentSrc || img.src };
    loaded.set(img, load);
    const rec = current.get(img);
    if (rec) { rec.load = load; rec.url = load.url; }
  }
  document.addEventListener('load', onLoad, true);
  const observer = new MutationObserver(mutations => {
    for (const { target: img } of mutations) {
      if (img.localName !== 'img') { continue; }
      const state = img.getAttribute('data-safe-state');
      if (state === 'pending') {
        if (current.get(img)?.state === 'pending') { continue; }
        const rect = img.getBoundingClientRect();
        const rec = { img, state, scanAt: performance.now(), verdictAt: null,
          url: img.currentSrc || img.src, load: loaded.get(img),
          visible: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
          size: [Math.round(rect.width), Math.round(rect.height)] };
        current.set(img, rec);
        records.push(rec);
      } else {
        const rec = current.get(img);
        if (!rec) { continue; }
        rec.state = state;
        if ((state === 'clean' || state === 'flagged') && rec.verdictAt === null) {
          rec.verdictAt = performance.now();
          rec.url = img.currentSrc || rec.url;
          rec.method = img.getAttribute('data-safe-method');
        }
      }
    }
  });
  observer.observe(document, { subtree: true, attributes: true, attributeFilter: ['data-safe-state'] });

  window.__safeBench = { summary() {
    // Pages can preload the main photo with <link as="image">. Match
    // the selected URL across all initiator types so those photos are timed.
    const resources = performance.getEntriesByType('resource');
    return records.map(rec => {
      const matches = resources.filter(e => e.name === rec.url && e.startTime <= (rec.verdictAt || Infinity));
      const resource = matches.sort((a, b) => Math.abs(a.responseEnd - (rec.load?.at || rec.scanAt)) -
        Math.abs(b.responseEnd - (rec.load?.at || rec.scanAt)))[0];
      const start = resource?.startTime;
      const loadAt = rec.load?.url === rec.url ? rec.load.at : null;
      const round = value => value === null || value === undefined ? null : Math.round(value);
      return { state: !rec.img.isConnected && rec.verdictAt === null ? 'removed' : rec.state,
        method: rec.method, visible: rec.visible, initial: rec.scanAt < 2500, size: rec.size,
        pageLoadMs: start !== undefined && loadAt !== null ? round(loadAt - start) : null,
        scanDelayMs: start !== undefined ? round(rec.scanAt - start) : null,
        verdictMs: start !== undefined && rec.verdictAt !== null ? round(rec.verdictAt - start) : null,
        processingMs: rec.verdictAt !== null ? round(rec.verdictAt - rec.scanAt) : null,
        afterLoadMs: loadAt !== null && rec.verdictAt !== null ? round(Math.max(0, rec.verdictAt - loadAt)) : null,
        beforeLoad: loadAt !== null && rec.verdictAt !== null ? rec.verdictAt < loadAt : null };
    });
  }, stop() {
    observer.disconnect();
    document.removeEventListener('load', onLoad, true);
    delete window.__safeBench;
  } };
})();
