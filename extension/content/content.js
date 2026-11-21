// Content script: runs at document_start in every frame (isolated world).
//
//  - discovers <img> (src/srcset/currentSrc, lazy, added later), <canvas> and
//    elements with a CSS background-image url()
//  - measures rendered size with ResizeObserver: < 100x100 CSS px is never scanned
//  - gates work on proximity to the viewport with IntersectionObserver
//  - sends URLs to the service worker -> offscreen document (fetch path);
//    elements that cannot be fetched go to the captureVisibleTab fallback
//  - applies the verdict via data attributes matched by injected CSS
//
// Per-element state lives in a WeakMap and is mirrored to data-safe-* attrs:
//   data-safe-state   small | waiting | pending | capture | clean | flagged | error
//   data-safe-blur    flagged | pending       (present => blurred by CSS)
//   data-safe-method  fetch | capture
//   data-safe-top     "<label>:<score>" | "none"
(function () {
  'use strict';

  const previous = globalThis.__safeContent;
  if (previous) {
    if (previous.alive()) { return; }
    previous.shutdown();
  }

  const SAFE = globalThis.SAFE;
  const MIN = SAFE.MIN_RENDERED_PX;
  const MIN_NATURAL = 36; // intrinsic size below this is a spacer/placeholder (offscreen applies the same rule)
  const A_STATE = 'data-safe-state';
  const A_BLUR = 'data-safe-blur';
  const A_METHOD = 'data-safe-method';
  const A_TOP = 'data-safe-top';
  const A_REASON = 'data-safe-reason';
  const A_REVEALED = 'data-safe-revealed';
  const A_CAPTURING = 'data-safe-capturing';
  const A_CAPTURING_PAGE = 'data-safe-capturing-page';
  const A_ID = 'data-safe-id';
  const OUR_ATTRS = [A_STATE, A_BLUR, A_METHOD, A_TOP, A_REASON, A_REVEALED, A_CAPTURING, 'data-safe-id'];
  const SKIP_TAGS = new Set(['head', 'script', 'style', 'noscript', 'template', 'link', 'meta', 'safe-debug-tip']);
  const IS_TOP = window === window.top;
  const MAX_CAPTURE_TARGETS = 12;
  // Capture results are addressed by element id, and ids are only unique per
  // instance. A navigation between measure and results must not let a new
  // document apply an old document's verdicts.
  const INSTANCE = Math.random().toString(36).slice(2, 10);

  let settings = { ...SAFE.DEFAULT_SETTINGS };
  let settingsLoaded = false;
  let dead = false;
  let bgScan = document.readyState !== 'loading'; // computed styles are meaningful after DOMContentLoaded

  const recs = new WeakMap();      // element -> record
  const live = new Set();          // records of connected elements (pruned on stats pass)
  const captureById = new Map();   // id -> record waiting for the capture fallback
  const observedRoots = new Set(); // document + open shadow roots
  let nextId = 1;

  // ---------------------------------------------------------------- plumbing

  function runtimeAlive() {
    try { return Boolean(chrome.runtime && chrome.runtime.id); } catch { return false; }
  }

  async function send(msg) {
    if (dead) { return undefined; }
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (!runtimeAlive()) { shutdown(); } // extension reloaded: this copy is orphaned
      throw e;
    }
  }

  function debugLog(...args) {
    if (settings.debug) { console.info('[safe]', ...args); }
  }

  // ---------------------------------------------------------------- styles

  const baseSheet = new CSSStyleSheet();
  baseSheet.replaceSync(SAFE.BLUR_CSS);
  const debugSheet = new CSSStyleSheet();
  debugSheet.replaceSync(SAFE.DEBUG_CSS);

  function adoptInto(root) {
    const wanted = settings.debug ? [baseSheet, debugSheet] : [baseSheet];
    const others = root.adoptedStyleSheets.filter(s => s !== baseSheet && s !== debugSheet);
    root.adoptedStyleSheets = [...others, ...wanted];
  }

  // ---------------------------------------------------------------- state

  function verdict(result) {
    return result && result.top && result.top.score >= settings.threshold ? 'flagged' : 'clean';
  }

  function updateBlur(rec) {
    let blur = null;
    if (settings.enabled && !rec.revealed) {
      if (rec.state === 'flagged') {
        blur = 'flagged';
      } else if (settings.blurPending && rec.w >= MIN && rec.h >= MIN &&
                 (rec.state === 'pending' || rec.state === 'capture' || rec.state === 'waiting')) {
        blur = 'pending';
      }
    }
    if (blur) { rec.el.setAttribute(A_BLUR, blur); } else { rec.el.removeAttribute(A_BLUR); }
  }

  function setState(rec, state) {
    if (rec.state !== state) {
      rec.state = state;
      rec.el.setAttribute(A_STATE, state);
      scheduleStats();
    }
    updateBlur(rec);
  }

  function setError(rec, reason) {
    rec.reason = reason;
    rec.el.setAttribute(A_REASON, String(reason).slice(0, 200));
    setState(rec, 'error');
    debugLog('error', reason, rec.url || rec.kind, rec.el);
  }

  function resetRec(rec) {
    rec.generation++;
    rec.result = null;
    rec.method = null;
    rec.revealed = false;
    rec.url = null;
    rec.reason = null;
    rec.state = null;
    captureById.delete(rec.id);
    for (const a of OUR_ATTRS) { if (a !== A_ID) { rec.el.removeAttribute(a); } }
  }

  function applyResult(rec, result, method) {
    rec.result = result;
    rec.method = method;
    rec.el.setAttribute(A_METHOD, method);
    rec.el.setAttribute(A_TOP, result.top ? `${result.top.label}:${result.top.score}` : 'none');
    setState(rec, verdict(result));
    debugLog(method, rec.state, result.top ? `${result.top.label} ${result.top.score}` : '-', rec.url || `#${rec.id}`);
  }

  // ---------------------------------------------------------------- discovery

  function bgUrlOf(el) {
    const bi = getComputedStyle(el).backgroundImage;
    if (!bi || bi === 'none' || !bi.includes('url(')) { return null; }
    const m = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(bi);
    return m ? m[2] : null;
  }

  function track(el, kind, url) {
    const rec = {
      id: nextId++, el, kind,
      bgUrl: url || null, url: null,
      state: null, near: false, visible: false, w: 0, h: 0,
      result: null, method: null, revealed: false, reason: null,
      generation: 0, sourceKey: kind === 'img' ? imageSourceKey(el) : null,
    };
    recs.set(el, rec);
    live.add(rec);
    el.setAttribute(A_ID, String(rec.id));
    resizeObs.observe(el);
    nearObs.observe(el);
    return rec;
  }

  function consider(el) {
    const rec = recs.get(el);
    const tag = el.localName;
    if (rec) {
      if (rec.kind === 'bg' && bgScan) {
        const url = bgUrlOf(el);
        if (url !== rec.bgUrl) {
          resetRec(rec);
          rec.bgUrl = url;
          if (url) { evaluate(rec); }
        }
      }
      return;
    }
    if (tag === 'img') {
      track(el, 'img');
    } else if (tag === 'canvas') {
      track(el, 'canvas');
    } else if (bgScan) {
      const url = bgUrlOf(el);
      if (url) { track(el, 'bg', url); }
    }
  }

  // Time-sliced breadth-first walk (uBO's surveyor pattern: collect nodes in
  // the MutationObserver callback, process them later in small slices).
  const walkQueue = [];
  let walkHead = 0;
  let walkTimer = null;

  function queueNode(node) {
    if (dead || !node) { return; }
    walkQueue.push(node);
    if (walkTimer === null) { walkTimer = setTimeout(walk, 16); }
  }

  function walk() {
    walkTimer = null;
    const deadline = performance.now() + 8;
    while (walkHead < walkQueue.length) {
      const node = walkQueue[walkHead++];
      if (node.nodeType === 1) {
        if (SKIP_TAGS.has(node.localName)) { continue; }
        consider(node);
        if (node.shadowRoot) { observeRoot(node.shadowRoot); }
        for (let c = node.firstElementChild; c !== null; c = c.nextElementSibling) { walkQueue.push(c); }
      } else if (node.nodeType === 9 || node.nodeType === 11) { // document / shadow root
        for (let c = node.firstElementChild; c !== null; c = c.nextElementSibling) { walkQueue.push(c); }
      }
      if ((walkHead & 31) === 0 && performance.now() > deadline) {
        walkTimer = setTimeout(walk, 0);
        return;
      }
    }
    walkQueue.length = 0;
    walkHead = 0;
  }

  const mutationObs = new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) { queueNode(n); }
        }
      } else if (m.type === 'attributes' && m.attributeName === 'style' && bgScan) {
        queueNode(m.target); // background-image may have changed
      }
      if (m.type === 'attributes' && m.target.localName === 'img') {
        refreshImage(m.target);
      } else if (m.target.localName === 'source' || m.target.localName === 'picture') {
        const picture = m.target.localName === 'picture' ? m.target : m.target.parentElement;
        if (picture?.localName === 'picture') {
          for (const img of picture.querySelectorAll('img')) { refreshImage(img); }
        }
      }
    }
  });

  function observeRoot(root) {
    if (observedRoots.has(root)) { return; }
    observedRoots.add(root);
    mutationObs.observe(root, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['style', 'src', 'srcset', 'sizes', 'media', 'type'] });
    if (root !== document) { adoptInto(root); queueNode(root); }
  }

  // ---------------------------------------------------------------- size + proximity

  const resizeObs = new ResizeObserver(entries => {
    for (const e of entries) {
      const rec = recs.get(e.target);
      if (!rec) { continue; }
      const box = e.borderBoxSize && e.borderBoxSize[0];
      rec.w = box ? box.inlineSize : e.contentRect.width;
      rec.h = box ? box.blockSize : e.contentRect.height;
      evaluate(rec);
    }
  });

  // Scan ahead of the user: 1.5 viewports above and below.
  const nearObs = new IntersectionObserver(entries => {
    for (const e of entries) {
      const rec = recs.get(e.target);
      if (!rec) { continue; }
      rec.near = e.isIntersecting;
      if (rec.near) { evaluate(rec); }
    }
  }, { rootMargin: '150% 0px 150% 0px' });

  // Capture fallback needs the element actually on screen.
  const visibleObs = new IntersectionObserver(entries => {
    let any = false;
    for (const e of entries) {
      const rec = recs.get(e.target);
      if (!rec) { continue; }
      const area = e.intersectionRect.width * e.intersectionRect.height;
      rec.visible = e.isIntersecting &&
        (e.intersectionRatio >= 0.5 || area >= 0.4 * innerWidth * innerHeight);
      if (rec.visible && rec.state === 'capture') { any = true; }
    }
    if (any) { requestCapture(); }
  }, { threshold: [0, 0.25, 0.5, 0.75, 1] });

  // ---------------------------------------------------------------- evaluation

  function imageSourceKey(img) {
    const sources = img.parentElement?.localName === 'picture'
      ? [...img.parentElement.querySelectorAll('source')].map(s => [s.srcset, s.sizes, s.media, s.type]) : [];
    return JSON.stringify([img.getAttribute('src'), img.srcset, img.sizes, img.baseURI, sources]);
  }

  function refreshImage(img) {
    const rec = recs.get(img);
    if (!rec) { queueNode(img); return; }
    const key = imageSourceKey(img);
    if (key !== rec.sourceKey) {
      resetRec(rec);
      rec.sourceKey = key;
      evaluate(rec);
    }
  }

  // Read candidate URLs, not densities/media choices. The browser decides
  // which to request; the service worker matches that exact request to these.
  // A comma inside a URL (notably data:) is legal in srcset.
  function imageCandidates(img) {
    const urls = new Set();
    function add(value) {
      if (!value) { return; }
      try { urls.add(new URL(value, img.baseURI).href); } catch { }
    }
    function srcset(value) {
      const tokens = /[^\t\n\f\r ,][^\t\n\f\r ]*/g;
      let match;
      while ((match = tokens.exec(value))) {
        const token = match[0];
        add(token.replace(/,+$/, ''));
        if (!token.endsWith(',')) {
          // Skip optional descriptors up to the next candidate separator.
          const comma = value.indexOf(',', tokens.lastIndex);
          if (comma < 0) { break; }
          tokens.lastIndex = comma + 1;
        }
      }
    }
    add(img.getAttribute('src'));
    srcset(img.srcset);
    if (img.parentElement?.localName === 'picture') {
      for (const source of img.parentElement.querySelectorAll('source')) { srcset(source.srcset); }
    }
    return [...urls];
  }

  function evaluate(rec) {
    if (dead || !settingsLoaded || !settings.enabled) { return; }
    if (!rec.el.isConnected) { return; }
    // Invalidate even an in-flight verdict if an image shrinks below the gate.
    if (rec.w < MIN || rec.h < MIN) {
      if (rec.state !== 'small') { resetRec(rec); }
      setState(rec, 'small');
      return;
    }
    const s = rec.state;
    if (s === 'pending' || s === 'capture' || s === 'clean' || s === 'flagged' || s === 'error') { return; }
    if (!rec.near) { setState(rec, 'waiting'); return; }

    if (rec.kind === 'canvas') { toCapture(rec, 'canvas'); return; }

    let url;
    if (rec.kind === 'img') {
      const img = rec.el;
      const responsive = img.srcset || img.parentElement?.localName === 'picture';
      url = img.complete ? img.currentSrc : responsive ? null : img.src;
      if (img.complete && !url) { setState(rec, 'waiting'); return; }
      if (img.complete && img.naturalWidth === 0) { setError(rec, 'broken-image'); return; }
      if (img.complete && (img.naturalWidth < MIN_NATURAL || img.naturalHeight < MIN_NATURAL)) {
        // Lazy-load placeholder (1x1 gif etc.): wait for the real src, whose
        // 'load' event re-evaluates. Not worth a round trip.
        rec.reason = `placeholder ${img.naturalWidth}x${img.naturalHeight}`;
        setState(rec, 'waiting');
        return;
      }
      if (!url && !imageCandidates(img).length) { setState(rec, 'waiting'); return; }
    } else {
      url = rec.bgUrl;
      if (!url) { return; }
    }
    classify(rec, url);
  }

  function classify(rec, url) {
    const generation = rec.generation;
    rec.url = url;
    setState(rec, 'pending');
    send({ what: 'classify', url, candidates: url ? undefined : imageCandidates(rec.el) }).then(resp => {
      if (dead || !rec.el.isConnected || rec.generation !== generation || rec.state !== 'pending') { return; }
      if (rec.kind === 'img' && imageSourceKey(rec.el) !== rec.sourceKey) { refreshImage(rec.el); return; }
      if (resp?.waiting) {
        setState(rec, 'waiting');
        if (rec.kind === 'img' && rec.el.complete) { evaluate(rec); }
        return;
      }
      if (rec.kind === 'img' && rec.el.complete && rec.el.currentSrc && resp?.url && rec.el.currentSrc !== resp.url) {
        resetRec(rec); evaluate(rec); return;
      }
      rec.url = resp?.url || url;
      if (resp && resp.ok) {
        if (resp.result.note?.startsWith('tiny-natural')) {
          rec.reason = resp.result.note;
          setState(rec, 'waiting');
          return;
        }
        applyResult(rec, resp.result, 'fetch');
      } else if (resp && resp.fatal) {
        setError(rec, resp.reason);
      } else {
        // Capture needs the page's pixels. An early fetch failure must not
        // capture a blank image and cache it as a clean verdict.
        if (rec.kind === 'img' && !rec.el.complete) { setState(rec, 'waiting'); return; }
        toCapture(rec, resp ? resp.reason : 'no-response');
      }
    }, err => {
      if (!dead && rec.generation === generation && rec.state === 'pending' && rec.el.isConnected) {
        if (rec.kind === 'img' && !rec.el.complete) { setState(rec, 'waiting'); return; }
        toCapture(rec, `message:${err.message}`);
      }
    });
  }

  // ---------------------------------------------------------------- capture fallback

  function toCapture(rec, reason) {
    rec.reason = reason;
    rec.el.setAttribute(A_REASON, String(reason).slice(0, 200));
    if (!IS_TOP) {
      // Subframe rects are relative to the frame, not to the tab screenshot.
      setError(rec, `${reason}; capture fallback is top-frame only`);
      return;
    }
    setState(rec, 'capture');
    captureById.set(rec.id, rec);
    visibleObs.observe(rec.el);
    debugLog('needs capture:', reason, rec.url || rec.kind);
  }

  let captureRequestTimer = null;
  function requestCapture() {
    if (captureRequestTimer !== null || document.visibilityState !== 'visible') { return; }
    captureRequestTimer = setTimeout(() => {
      captureRequestTimer = null;
      send({ what: 'requestCapture' }).catch(() => {});
    }, 60);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { return; }
    for (const rec of captureById.values()) {
      if (rec.visible) { requestCapture(); break; }
    }
  });

  function nextFrames() {
    return new Promise(resolve => {
      const t = setTimeout(resolve, 120);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); resolve(); }));
    });
  }

  async function measureForCapture() {
    const vw = innerWidth;
    const vh = innerHeight;
    const targets = [];
    let more = false;
    let changedPixels = false;
    for (const rec of captureById.values()) {
      if (!rec.el.isConnected) { captureById.delete(rec.id); continue; }
      const r = rec.el.getBoundingClientRect();
      const x1 = Math.max(0, r.left), y1 = Math.max(0, r.top);
      const x2 = Math.min(vw, r.right), y2 = Math.min(vh, r.bottom);
      const w = x2 - x1, h = y2 - y1;
      if (w < 32 || h < 32) { continue; }
      if (w * h < 0.5 * Math.min(r.width * r.height, vw * vh)) { continue; }
      if (targets.length >= MAX_CAPTURE_TARGETS) { more = true; break; }
      targets.push({
        id: rec.id,
        url: rec.kind === 'canvas' ? null : rec.url || rec.bgUrl,
        rect: { x: x1, y: y1, w, h },
      });
      if (rec.el.hasAttribute(A_BLUR)) { changedPixels = true; }
      rec.el.setAttribute(A_CAPTURING, '');
    }
    if (targets.length !== 0) {
      document.documentElement.setAttribute(A_CAPTURING_PAGE, '');
      if (tip) { tip.host.style.display = 'none'; }
      if (changedPixels || settings.debug) { await nextFrames(); }
    }
    return { instance: INSTANCE, viewport: { w: vw, h: vh, dpr: devicePixelRatio }, targets, more };
  }

  // A canvas can be captured before the page has drawn into it. Clean
  // canvases are captured again a couple of times before being trusted.
  const CANVAS_RECHECK_MS = [1500, 5000];
  function scheduleCanvasRecheck(rec) {
    if (rec.kind !== 'canvas' || rec.state !== 'clean') { return; }
    const n = rec.rechecks || 0;
    if (n >= CANVAS_RECHECK_MS.length) { return; }
    rec.rechecks = n + 1;
    setTimeout(() => {
      if (dead || rec.state !== 'clean' || !rec.el.isConnected) { return; }
      debugLog('re-capturing canvas', rec.id, `(${rec.rechecks}/${CANVAS_RECHECK_MS.length})`);
      toCapture(rec, `canvas recheck ${rec.rechecks}`);
      if (rec.visible) { requestCapture(); }
    }, CANVAS_RECHECK_MS[n]);
  }

  function captureDone() {
    document.documentElement.removeAttribute(A_CAPTURING_PAGE);
    for (const rec of captureById.values()) { rec.el.removeAttribute(A_CAPTURING); }
  }

  function captureResults(results) {
    for (const r of results || []) {
      const rec = captureById.get(r.id);
      if (!rec) { continue; }
      rec.el.removeAttribute(A_CAPTURING);
      if (r.ok) {
        captureById.delete(r.id);
        visibleObs.unobserve(rec.el);
        applyResult(rec, r.result, 'capture');
        scheduleCanvasRecheck(rec);
      } else if (r.reason !== 'crop-empty') {
        captureById.delete(r.id);
        setError(rec, `capture:${r.reason}`);
      }
    }
    // Anything still visible and waiting gets another round.
    for (const rec of captureById.values()) {
      if (rec.visible) { requestCapture(); break; }
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (dead || !msg) { return; }
    switch (msg.what) {
      case 'captureMeasure':
        measureForCapture().then(sendResponse, () => sendResponse(null));
        return true;
      case 'captureDone':
        if (msg.instance === INSTANCE) { captureDone(); }
        break;
      case 'captureResults':
        if (msg.instance === INSTANCE) {
          captureResults(msg.results);
        } else {
          debugLog('dropped capture results meant for another document instance');
        }
        break;
    }
  });

  // ---------------------------------------------------------------- img load / src changes

  function onImgEvent(e) {
    const el = e.target;
    if (!el || el.localName !== 'img') { return; }
    let rec = recs.get(el);
    if (!rec) { rec = track(el, 'img'); }
    refreshImage(el);
    const url = el.currentSrc || el.src;
    // A memory-cache hit may never appear in webRequest. Do not wait for the
    // URL-resolution timeout when load has already supplied currentSrc.
    if (rec.state === 'pending' && !rec.url && el.currentSrc) { resetRec(rec); }
    if (rec.url && url !== rec.url) {
      debugLog('src changed', rec.url, '->', url);
      resetRec(rec);
    }
    if (rec.state === 'waiting' || rec.state === null || rec.state === 'small') { evaluate(rec); }
  }
  document.addEventListener('load', onImgEvent, true);
  document.addEventListener('error', onImgEvent, true);

  // ---------------------------------------------------------------- stats

  let statsTimer = null;
  let lastStatsJson = '';
  function scheduleStats() {
    if (statsTimer !== null || dead) { return; }
    statsTimer = setTimeout(reportStats, 400);
  }

  function reportStats() {
    statsTimer = null;
    const s = { tracked: 0, small: 0, waiting: 0, pending: 0, scanned: 0, flagged: 0, revealed: 0, errors: 0, viaFetch: 0, viaCapture: 0 };
    for (const rec of live) {
      if (!rec.el.isConnected) {
        live.delete(rec);
        resizeObs.unobserve(rec.el);
        nearObs.unobserve(rec.el);
        visibleObs.unobserve(rec.el);
        captureById.delete(rec.id);
        continue;
      }
      s.tracked++;
      switch (rec.state) {
        case 'small': s.small++; break;
        case 'waiting': s.waiting++; break;
        case 'pending': case 'capture': s.pending++; break;
        case 'clean': s.scanned++; break;
        case 'flagged': s.scanned++; s.flagged++; if (rec.revealed) { s.revealed++; } break;
        case 'error': s.errors++; break;
      }
      if (rec.method === 'fetch') { s.viaFetch++; }
      if (rec.method === 'capture') { s.viaCapture++; }
    }
    const json = JSON.stringify(s);
    if (json === lastStatsJson) { return; }
    lastStatsJson = json;
    send({ what: 'stats', stats: s }).catch(() => {});
  }

  // ---------------------------------------------------------------- settings

  function reevaluateAll() {
    for (const rec of live) {
      if (rec.result && (rec.state === 'clean' || rec.state === 'flagged')) {
        setState(rec, verdict(rec.result));
      } else {
        evaluate(rec);
        updateBlur(rec);
      }
    }
    scheduleStats();
  }

  function applyDebug() {
    for (const root of observedRoots) { adoptInto(root); }
    if (!settings.debug && tip) { tip.host.style.display = 'none'; }
  }

  chrome.storage.local.get(null).then(stored => {
    settings = { ...SAFE.DEFAULT_SETTINGS, ...stored };
    settingsLoaded = true;
    applyDebug();
    reevaluateAll();
  }, () => { settingsLoaded = true; reevaluateAll(); });

  function onStorageChanged(changes, area) {
    if (area !== 'local' || dead) { return; }
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (k in SAFE.DEFAULT_SETTINGS) { settings[k] = newValue ?? SAFE.DEFAULT_SETTINGS[k]; }
    }
    if ('debug' in changes) { applyDebug(); }
    reevaluateAll();
  }
  chrome.storage.onChanged.addListener(onStorageChanged);

  // ---------------------------------------------------------------- debug: tooltip + click to reveal

  let tip = null;
  function ensureTip() {
    if (tip) { return tip; }
    const host = document.createElement('safe-debug-tip');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      :host { all: initial; position: fixed; z-index: 2147483647; pointer-events: none; display: none; }
      div { font: 12px/1.35 ui-monospace, monospace; color: #f9fafb; background: rgba(17,24,39,.94);
            border: 1px solid #374151; border-radius: 6px; padding: 5px 7px; max-width: 340px; white-space: pre; }
      b { color: #fca5a5; } i { color: #86efac; font-style: normal; }
    </style><div></div>`;
    (document.documentElement || document).appendChild(host);
    tip = { host, box: shadow.querySelector('div') };
    return tip;
  }

  function recAtPoint(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      const rec = recs.get(el);
      if (rec && rec.state && rec.state !== 'small') { return rec; }
    }
    return null;
  }

  function describe(rec) {
    const r = rec.result;
    const lines = [];
    const head = r && r.top ? `${r.top.label} ${(r.top.score * 100).toFixed(1)}%` : 'no detection';
    lines.push(`${rec.state === 'flagged' ? '<b>FLAGGED</b>' : `<i>${rec.state}</i>`}  ${head}  via ${rec.method || '-'}`);
    if (r && r.scores) {
      const others = Object.entries(r.scores).sort((a, b) => b[1] - a[1]).slice(1, 4)
        .map(([l, s]) => `${l} ${(s * 100).toFixed(0)}%`).join(', ');
      if (others) { lines.push(`also: ${others}`); }
    }
    if (rec.reason) { lines.push(`note: ${rec.reason}`); }
    lines.push(`threshold ${(settings.threshold * 100).toFixed(0)}%  ${Math.round(rec.w)}x${Math.round(rec.h)}px ${rec.kind}`);
    if (rec.state === 'flagged') { lines.push(rec.revealed ? 'click to blur again' : 'click to reveal'); }
    return lines.join('\n');
  }

  let moveRaf = 0;
  let lastMove = null;
  function onPointerMove(e) {
    if (!settings.debug) { return; }
    lastMove = e;
    if (moveRaf) { return; }
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      const ev = lastMove;
      const rec = recAtPoint(ev.clientX, ev.clientY);
      const t = ensureTip();
      if (!rec) { t.host.style.display = 'none'; return; }
      t.box.innerHTML = describe(rec);
      t.host.style.display = 'block';
      const x = Math.min(ev.clientX + 14, innerWidth - 350);
      const y = Math.min(ev.clientY + 16, innerHeight - 90);
      t.host.style.left = `${Math.max(0, x)}px`;
      t.host.style.top = `${Math.max(0, y)}px`;
    });
  }

  function onClick(e) {
    if (!settings.debug) { return; }
    const rec = recAtPoint(e.clientX, e.clientY);
    if (!rec || rec.state !== 'flagged') { return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    rec.revealed = !rec.revealed;
    rec.el.toggleAttribute(A_REVEALED, rec.revealed);
    updateBlur(rec);
    scheduleStats();
    if (tip) { tip.box.innerHTML = describe(rec); }
  }

  window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  window.addEventListener('click', onClick, true);

  // ---------------------------------------------------------------- lifecycle

  function shutdown() {
    if (dead) { return; }
    dead = true;
    mutationObs.disconnect();
    resizeObs.disconnect();
    nearObs.disconnect();
    visibleObs.disconnect();
    clearTimeout(walkTimer);
    clearTimeout(statsTimer);
    clearTimeout(captureRequestTimer);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('click', onClick, true);
    document.removeEventListener('load', onImgEvent, true);
    document.removeEventListener('error', onImgEvent, true);
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch { }
    for (const rec of live) {
      for (const a of OUR_ATTRS) { rec.el.removeAttribute(a); }
    }
    for (const root of observedRoots) {
      try { root.adoptedStyleSheets = root.adoptedStyleSheets.filter(s => s !== baseSheet && s !== debugSheet); } catch { }
    }
    if (tip) { tip.host.remove(); }
  }

  // Debug hook, reachable only from this isolated world (e.g. CDP Runtime.evaluate
  // with the extension's contextId). See test/bh_helpers.py:content_eval.
  function inspect(el) {
    const rec = recs.get(el);
    if (!rec) { return null; }
    const { el: _e, result, ...rest } = rec;
    return { ...rest, top: result && result.top, complete: el.complete, currentSrc: el.currentSrc };
  }
  globalThis.__safeContent = {
    alive: () => !dead && runtimeAlive(),
    shutdown,
    inspect,
    byId: id => [...live].find(r => r.id === Number(id)),
    settings: () => ({ ...settings, settingsLoaded }),
  };

  // ---------------------------------------------------------------- start

  send({ what: 'hello' }).catch(() => {});
  adoptInto(document);
  observeRoot(document);
  queueNode(document);
  if (!bgScan) {
    document.addEventListener('DOMContentLoaded', () => { bgScan = true; queueNode(document); }, { once: true });
  }
  // Late stylesheets can add background images: one more pass after load.
  window.addEventListener('load', () => { bgScan = true; queueNode(document); }, { once: true });
})();
