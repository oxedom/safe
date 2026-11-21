// Offscreen document: owns TF.js, the model, the inference queue and the
// verdict cache. Serves every tab. Talks only to the service worker, through
// chrome.runtime messages whose `what` starts with "offscreen:" (the only
// chrome.* API an offscreen document has is chrome.runtime).
(function () {
  'use strict';

  const DETECTOR = self.SafeDetectors[self.SAFE.DETECTOR_ID];
  const MODEL_URL = chrome.runtime.getURL('models/yolov7/model.json');
  const MIN_NATURAL_PX = 36;          // stretched 1x1 spacers etc. (idea from Wingman Jr.)
  const MAX_BYTES = 30 * 1024 * 1024;
  const FETCH_TIMEOUT_MS = 15000;
  const FETCH_CONCURRENCY = 6;
  const CACHE_MAX = 4000;
  const LOG_MAX = 300;

  const state = {
    backend: null,
    ready: false,
    error: null,
    loadMs: 0,
    inferences: 0,
    inferMsTotal: 0,
    queued: 0,
  };
  const cache = new Map();     // key -> result (Map keeps insertion order => LRU)
  const inflight = new Map();  // key -> Promise<response>
  const logRing = [];
  let lastCapture = null;      // { dataUrl, viewport, targets, results } for debugging crop alignment

  // ---------------------------------------------------------------- utils

  function log(entry) {
    entry.t = Date.now();
    logRing.push(entry);
    if (logRing.length > LOG_MAX) { logRing.shift(); }
    const top = entry.top ? `${entry.top.label} ${entry.top.score.toFixed(2)}` : '-';
    console.info(`[safe] ${entry.method} ${entry.outcome} ${top} ${entry.ms ?? ''}ms ${entry.url ?? entry.id ?? ''}`);
  }

  function cacheKey(url) { return `${DETECTOR.id}@${DETECTOR.version}|${url}`; }

  function cacheGet(key) {
    if (!cache.has(key)) { return undefined; }
    const v = cache.get(key);
    cache.delete(key);
    cache.set(key, v);
    return v;
  }

  function cacheSet(key, value) {
    cache.set(key, value);
    if (cache.size > CACHE_MAX) { cache.delete(cache.keys().next().value); }
  }

  function round3(x) { return Math.round(x * 1000) / 1000; }

  // Simple counting semaphore for network concurrency.
  function semaphore(n) {
    let active = 0;
    const waiters = [];
    return async function run(fn) {
      if (active >= n) { await new Promise(r => waiters.push(r)); }
      active++;
      try { return await fn(); } finally {
        active--;
        const next = waiters.shift();
        if (next) { next(); }
      }
    };
  }
  const netSlot = semaphore(FETCH_CONCURRENCY);

  // All inference goes through one serial chain: the GPU runs one graph at a time.
  let gpuChain = Promise.resolve();
  function infer(source, w, h) {
    state.queued++;
    const job = gpuChain.then(async () => {
      await readyPromise;
      if (!state.ready) { throw new Error(state.error || 'model not ready'); }
      const t0 = performance.now();
      const result = await DETECTOR.classify(source, w, h);
      const ms = performance.now() - t0;
      state.inferences++;
      state.inferMsTotal += ms;
      result.ms = Math.round(ms);
      if (result.top) { result.top.score = round3(result.top.score); }
      return result;
    }).finally(() => { state.queued--; });
    gpuChain = job.catch(() => {});
    return job;
  }

  // ---------------------------------------------------------------- model

  async function pickBackend(requested) {
    const order = requested && requested !== 'auto'
      ? [requested, 'webgl', 'cpu']
      : ['webgpu', 'webgl', 'cpu'];
    for (const name of order) {
      if (name === 'webgpu' && !('gpu' in navigator)) { continue; }
      try {
        if (await tf.setBackend(name)) {
          await tf.ready();
          return tf.getBackend();
        }
      } catch (e) {
        console.warn(`[safe] backend ${name} failed:`, e);
      }
    }
    throw new Error('no TF.js backend available');
  }

  async function init() {
    const t0 = performance.now();
    let settings = {};
    try {
      settings = await chrome.runtime.sendMessage({ what: 'sw:offscreenSettings' }) || {};
    } catch { }
    tf.env().set('PROD', true); // skips NaN/debug checks (tf.enableProdMode was removed in TF.js 4)
    state.backend = await pickBackend(settings.backend);
    if (state.backend === 'cpu') {
      console.warn('[safe] running on the CPU backend: expect seconds per image');
    }
    await DETECTOR.load(tf, MODEL_URL);
    state.loadMs = Math.round(performance.now() - t0);
    state.ready = true;
    console.info(`[safe] ${DETECTOR.id} ready on ${state.backend} in ${state.loadMs}ms`);
  }
  const readyPromise = init().catch(e => {
    state.error = String(e && e.message || e);
    console.error('[safe] model init failed', e);
  });

  // ---------------------------------------------------------------- decode

  // Returns { source, w, h, release() }.
  async function decodeBlob(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      return { source: bmp, w: bmp.width, h: bmp.height, release: () => bmp.close() };
    } catch {
      // SVG (and anything else createImageBitmap rejects) via an <img>.
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      try {
        await img.decode();
      } catch (e) {
        URL.revokeObjectURL(url);
        throw e;
      }
      const w = img.naturalWidth || 640;
      const h = img.naturalHeight || 640;
      return { source: img, w, h, release: () => URL.revokeObjectURL(url) };
    }
  }

  // ---------------------------------------------------------------- primary path: fetch

  class FetchError extends Error {
    constructor(reason) { super(reason); this.reason = reason; }
  }

  async function fetchImage(url) {
    const scheme = url.slice(0, url.indexOf(':'));
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'data') {
      // blob: URLs belong to the page's origin; extension contexts cannot read them.
      throw new FetchError(`unsupported-scheme:${scheme}`);
    }
    return netSlot(async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      let res;
      try {
        // Extension pages with <all_urls> host permission are exempt from CORS.
        res = await fetch(url, { credentials: 'include', signal: ac.signal, cache: 'force-cache' });
      } catch (e) {
        throw new FetchError(`network:${e.name}`);
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) { throw new FetchError(`http-${res.status}`); }
      const len = Number(res.headers.get('content-length') || 0);
      if (len > MAX_BYTES) { throw new FetchError('too-large'); }
      const blob = await res.blob();
      if (blob.size === 0) { throw new FetchError('empty'); }
      return blob;
    });
  }

  async function classifyUrl(url) {
    const key = cacheKey(url);
    const hit = cacheGet(key);
    if (hit) { return { ok: true, result: hit, method: 'fetch', cached: true }; }
    if (inflight.has(key)) { return inflight.get(key); }

    const p = (async () => {
      const t0 = performance.now();
      let blob;
      try {
        blob = await fetchImage(url);
      } catch (e) {
        const reason = e.reason || `fetch:${e.message}`;
        log({ method: 'fetch', outcome: `fail(${reason})`, url });
        return { ok: false, reason };
      }
      let img;
      try {
        img = await decodeBlob(blob);
      } catch {
        log({ method: 'fetch', outcome: 'fail(decode)', url });
        return { ok: false, reason: `decode-failed:${blob.type || 'unknown'}` };
      }
      try {
        let result;
        if (img.w < MIN_NATURAL_PX || img.h < MIN_NATURAL_PX) {
          result = { top: null, scores: {}, detections: [], note: `tiny-natural ${img.w}x${img.h}`, ms: 0 };
        } else {
          result = await infer(img.source, img.w, img.h);
        }
        result.natural = [img.w, img.h];
        cacheSet(key, result);
        log({ method: 'fetch', outcome: 'ok', top: result.top, ms: Math.round(performance.now() - t0), url });
        return { ok: true, result, method: 'fetch' };
      } catch (e) {
        log({ method: 'fetch', outcome: `fail(model:${e.message})`, url });
        return { ok: false, reason: `model:${e.message}`, fatal: true };
      } finally {
        img.release();
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  // ---------------------------------------------------------------- fallback path: tab capture crops

  // One captureVisibleTab screenshot, many element rects (CSS px, viewport
  // relative, measured right before the capture). Scale is derived from the
  // screenshot itself, which folds in devicePixelRatio and page zoom.
  async function classifyCapture({ dataUrl, viewport, targets }) {
    const blob = await (await fetch(dataUrl)).blob();
    const shot = await createImageBitmap(blob);
    const sx = shot.width / viewport.w;
    const sy = shot.height / viewport.h;
    if (Math.abs(sx - viewport.dpr) > 0.05) {
      console.info(`[safe] capture scale ${sx.toFixed(3)} != dpr ${viewport.dpr} (zoom?)`);
    }
    const results = [];
    for (const t of targets) {
      const t0 = performance.now();
      const x = Math.max(0, Math.round(t.rect.x * sx));
      const y = Math.max(0, Math.round(t.rect.y * sy));
      const w = Math.min(shot.width - x, Math.round(t.rect.w * sx));
      const h = Math.min(shot.height - y, Math.round(t.rect.h * sy));
      if (w < 16 || h < 16) {
        results.push({ id: t.id, ok: false, reason: 'crop-empty' });
        continue;
      }
      let crop;
      try {
        crop = await createImageBitmap(shot, x, y, w, h);
        const result = await infer(crop, w, h);
        result.crop = [x, y, w, h];
        if (t.url) { cacheSet(cacheKey(t.url), result); }
        log({ method: 'capture', outcome: 'ok', top: result.top, ms: Math.round(performance.now() - t0), url: t.url || `#${t.id}` });
        results.push({ id: t.id, ok: true, result });
      } catch (e) {
        log({ method: 'capture', outcome: `fail(${e.message})`, url: t.url || `#${t.id}` });
        results.push({ id: t.id, ok: false, reason: `model:${e.message}` });
      } finally {
        if (crop) { crop.close(); }
      }
    }
    shot.close();
    lastCapture = { at: Date.now(), dataUrl, viewport, targets, results: results.map(r => ({ id: r.id, ok: r.ok, top: r.result && r.result.top, crop: r.result && r.result.crop })) };
    return { results, shot: [shot.width, shot.height], scale: round3(sx) };
  }

  // ---------------------------------------------------------------- messaging

  function status() {
    return {
      detector: DETECTOR.id,
      backend: state.backend,
      ready: state.ready,
      error: state.error,
      loadMs: state.loadMs,
      inferences: state.inferences,
      avgInferMs: state.inferences ? Math.round(state.inferMsTotal / state.inferences) : 0,
      queued: state.queued,
      inflight: inflight.size,
      cacheSize: cache.size,
      log: logRing.slice(-80),
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.what !== 'string' || !msg.what.startsWith('offscreen:')) {
      return; // not ours: let the service worker answer
    }
    let p;
    switch (msg.what) {
      case 'offscreen:classifyUrl': p = classifyUrl(msg.url); break;
      case 'offscreen:classifyCapture': p = classifyCapture(msg); break;
      case 'offscreen:status': p = Promise.resolve(status()); break;
      case 'offscreen:lastCapture': p = Promise.resolve(lastCapture); break;
      case 'offscreen:clearCache': cache.clear(); p = Promise.resolve({ ok: true }); break;
      case 'offscreen:reload': setTimeout(() => location.reload(), 10); p = Promise.resolve({ ok: true }); break;
      default: return;
    }
    p.then(sendResponse, e => sendResponse({ ok: false, reason: `offscreen:${e && e.message}` }));
    return true;
  });
})();
