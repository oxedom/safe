// Service worker: message router, offscreen-document lifecycle, the
// rate-limited captureVisibleTab scheduler, per-tab stats and the badge.
//
// Message namespaces (`what`), following uBO Lite's convention that a ':'
// marks a message meant for a different listener:
//   content -> sw       hello, classify, requestCapture, stats
//   popup   -> sw       getTabStats, getStatus, reloadModel
//   sw -> offscreen     offscreen:*
//   offscreen -> sw     sw:*
//   sw -> content       captureMeasure, captureDone, captureResults (tabs.sendMessage)
importScripts('../shared/defaults.js');

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const CAPTURE_MIN_INTERVAL_MS = 550; // Chrome allows ~2 captureVisibleTab calls / second


// ------------------------------------------------------------------ settings

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(SAFE.DEFAULT_SETTINGS));
  return { ...SAFE.DEFAULT_SETTINGS, ...stored };
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const stored = await chrome.storage.local.get(null);
  await chrome.storage.local.set({ ...SAFE.DEFAULT_SETTINGS, ...stored });
  console.info(`[safe] installed (${reason})`);
  // Content scripts declared in the manifest do not run in tabs that were
  // already open: inject them so a reload of the extension takes effect.
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*', 'file://*/*'] });
  for (const tab of tabs) {
    chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['shared/defaults.js', 'content/content.js'],
    }).catch(() => {});
  }
});

// ------------------------------------------------------------------ offscreen

let creatingOffscreen = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (creatingOffscreen) { return creatingOffscreen; }
  if (await hasOffscreen()) { return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['WORKERS', 'BLOBS'],
    justification: 'Run the TF.js image model on WebGL/WebGPU and decode fetched images.',
  }).catch(e => {
    // A concurrent creation from a previous worker lifetime is fine.
    if (!String(e).includes('Only a single offscreen')) { throw e; }
  }).finally(() => { creatingOffscreen = null; });
  return creatingOffscreen;
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  for (let attempt = 0; ; attempt++) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      // The document exists but its listener may not be registered yet.
      if (attempt >= 5 || !String(e).includes('Receiving end does not exist')) { throw e; }
      await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
    }
  }
}

// ---------------------------------------------------------- early image URLs

// currentSrc can stay empty until load for responsive images. Remember only
// the browser's chosen URLs; observing a request never downloads or scans it.
// A content-script message, after the size/proximity gates, authorizes work.
const imageRequests = new Map();
const imageWaiters = new Set();
const IMAGE_REQUEST_MAX = 2048;
const IMAGE_REQUEST_TTL_MS = 15000;

function sameDocument(a, b) {
  return a.tabId === b.tabId && a.frameId === b.frameId && a.documentId === b.documentId;
}

chrome.webRequest.onBeforeRequest.addListener(details => {
  if (details.tabId < 0) { return; } // includes none of the offscreen fetches
  const key = `${details.tabId}:${details.frameId}:${details.documentId}:${details.url}`;
  imageRequests.delete(key);
  imageRequests.set(key, details);
  while (imageRequests.size > IMAGE_REQUEST_MAX) { imageRequests.delete(imageRequests.keys().next().value); }
  for (const waiter of imageWaiters) {
    if (sameDocument(waiter, details) && waiter.urls.has(details.url)) { waiter.finish(details.url); }
  }
}, { urls: ['<all_urls>'], types: ['image'] });

function selectedImageUrl(candidates, sender) {
  const scope = { tabId: sender.tab?.id, frameId: sender.frameId, documentId: sender.documentId };
  if (scope.tabId === undefined) { return Promise.resolve(null); }
  const urls = new Set(candidates);
  const matches = new Set();
  for (const [key, request] of imageRequests) {
    if (Date.now() - request.timeStamp > IMAGE_REQUEST_TTL_MS) { imageRequests.delete(key); continue; }
    if (sameDocument(scope, request) && urls.has(request.url)) { matches.add(request.url); }
  }
  // Multiple elements can share a srcset but choose different candidates.
  // webRequest has no element id, so do not guess when the history is ambiguous.
  if (matches.size > 1) { return Promise.resolve(null); }
  if (matches.size === 1) { return Promise.resolve(matches.values().next().value); }
  // The content script can beat the browser's request. Memory-cache hits are
  // invisible to webRequest: return "waiting" and let load supply currentSrc.
  if (imageWaiters.size >= 256) { return Promise.resolve(null); }
  return new Promise(resolve => {
    const waiter = { ...scope, urls, finish(url) {
      clearTimeout(timer);
      imageWaiters.delete(waiter);
      resolve(url);
    } };
    const timer = setTimeout(() => waiter.finish(null), 300);
    imageWaiters.add(waiter);
  });
}

function clearImageRequests(tabId, frameId, keepDocumentId) {
  for (const [key, request] of imageRequests) {
    if (request.tabId === tabId && (frameId === undefined || request.frameId === frameId) &&
        (!keepDocumentId || request.documentId !== keepDocumentId)) { imageRequests.delete(key); }
  }
  for (const waiter of imageWaiters) {
    if (waiter.tabId === tabId && (frameId === undefined || waiter.frameId === frameId) &&
        (!keepDocumentId || waiter.documentId !== keepDocumentId)) { waiter.finish(null); }
  }
}

// ------------------------------------------------------------------ stats + badge

// tabId -> { frameId -> stats }. Mirrored to storage.session so the popup can
// read it and so it survives service worker restarts.
const tabStats = new Map();
let statsLoaded = chrome.storage.session.get(null).then(all => {
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('stats:')) { tabStats.set(Number(k.slice(6)), v); }
  }
});

function sumStats(frames) {
  const total = {};
  for (const s of Object.values(frames || {})) {
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === 'number') { total[k] = (total[k] || 0) + v; }
    }
  }
  return total;
}

async function setFrameStats(tabId, frameId, stats) {
  await statsLoaded;
  const frames = tabStats.get(tabId) || {};
  frames[frameId] = stats;
  tabStats.set(tabId, frames);
  chrome.storage.session.set({ [`stats:${tabId}`]: frames }).catch(() => {});
  const total = sumStats(frames);
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: total.flagged ? String(total.flagged) : '' }).catch(() => {});
}

async function clearTabStats(tabId) {
  await statsLoaded;
  tabStats.delete(tabId);
  chrome.storage.session.remove(`stats:${tabId}`).catch(() => {});
}

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, documentId }) => {
  clearImageRequests(tabId, frameId === 0 ? undefined : frameId, documentId);
  if (frameId === 0) { clearTabStats(tabId); }
});
chrome.tabs.onRemoved.addListener(tabId => {
  clearImageRequests(tabId);
  clearTabStats(tabId);
  captureWanted.delete(tabId);
  captureParked.delete(tabId);
});

// ------------------------------------------------------------------ capture fallback

const captureWanted = new Set();   // tabs with elements waiting for a capture
const captureParked = new Set();   // ... whose tab is not the visible one right now
let capturing = false;
let lastCaptureAt = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function pumpCaptures() {
  if (capturing) { return; }
  capturing = true;
  try {
    while (captureWanted.size !== 0) {
      const tabId = captureWanted.values().next().value;
      captureWanted.delete(tabId);
      let tab;
      try { tab = await chrome.tabs.get(tabId); } catch { continue; }
      if (!tab.active) { captureParked.add(tabId); continue; }

      const wait = lastCaptureAt + CAPTURE_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) { await sleep(wait); }

      // Measure right before capturing so the rects match the screenshot.
      let measure;
      try {
        measure = await chrome.tabs.sendMessage(tabId, { what: 'captureMeasure' }, { frameId: 0 });
      } catch { continue; }
      if (!measure || measure.targets.length === 0) { continue; }

      let dataUrl;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      } catch (e) {
        console.warn('[safe] captureVisibleTab failed:', e.message);
        if (String(e.message).includes('MAX_CAPTURE')) { captureWanted.add(tabId); }
        continue;
      } finally {
        lastCaptureAt = Date.now();
        chrome.tabs.sendMessage(tabId, { what: 'captureDone', instance: measure.instance }, { frameId: 0 }).catch(() => {});
      }

      let res;
      try {
        res = await toOffscreen({
          what: 'offscreen:classifyCapture',
          dataUrl,
          viewport: measure.viewport,
          targets: measure.targets,
        });
      } catch (e) {
        res = { results: measure.targets.map(t => ({ id: t.id, ok: false, reason: `offscreen:${e.message}` })) };
      }
      console.info(`[safe] capture tab ${tabId}: ${measure.targets.length} crops from one screenshot`, res.shot, 'scale', res.scale);
      chrome.tabs.sendMessage(tabId, { what: 'captureResults', instance: measure.instance, results: res.results }, { frameId: 0 }).catch(() => {});
      if (measure.more) { captureWanted.add(tabId); }
    }
  } finally {
    capturing = false;
  }
}

function wakeParked(tabId) {
  if (!captureParked.delete(tabId)) { return; }
  captureWanted.add(tabId);
  pumpCaptures();
}
chrome.tabs.onActivated.addListener(({ tabId }) => wakeParked(tabId));

// ------------------------------------------------------------------ router

async function onMessage(msg, sender) {
  const tabId = sender.tab ? sender.tab.id : undefined;
  const frameId = sender.frameId;

  switch (msg.what) {
    case 'hello':
      // uBO pattern: user-origin stylesheet so page CSS (even !important)
      // cannot cancel the blur. The content script also adopts the same
      // rules immediately so nothing waits for this round trip.
      if (tabId !== undefined) {
        await chrome.scripting.insertCSS({
          target: { tabId, frameIds: [frameId] },
          css: SAFE.BLUR_CSS,
          origin: 'USER',
        }).catch(e => console.warn('[safe] insertCSS', e.message));
      }
      return { tabId, frameId };

    case 'classify': {
      const url = msg.url || await selectedImageUrl(msg.candidates || [], sender);
      if (!url) { return { waiting: true }; }
      return { ...await toOffscreen({ what: 'offscreen:classifyUrl', url }), url };
    }

    case 'requestCapture':
      if (tabId === undefined || frameId !== 0) { return { queued: false }; }
      captureWanted.add(tabId);
      pumpCaptures();
      return { queued: true };

    case 'stats':
      if (tabId !== undefined) { await setFrameStats(tabId, frameId, msg.stats); }
      return { ok: true };

    case 'getTabStats': {
      await statsLoaded;
      const frames = tabStats.get(msg.tabId) || {};
      return { total: sumStats(frames), frames: Object.keys(frames).length };
    }

    case 'getStatus':
      if (!(await hasOffscreen())) { return { running: false }; }
      return { running: true, ...(await toOffscreen({ what: 'offscreen:status' })) };

    case 'reloadModel':
      if (await hasOffscreen()) { await chrome.offscreen.closeDocument(); }
      await ensureOffscreen();
      return { ok: true };

    case 'sw:offscreenSettings':
      return getSettings();
  }
  return undefined;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.what !== 'string') { return; }
  if (msg.what.startsWith('offscreen:')) { return; } // the offscreen document answers these
  onMessage(msg, sender).then(sendResponse, e => {
    console.warn('[safe] handler failed', msg.what, e);
    sendResponse({ ok: false, reason: `sw:${e && e.message}` });
  });
  return true;
});

// Changing the backend needs a fresh offscreen document.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.backend) {
    onMessage({ what: 'reloadModel' }, {}).catch(() => {});
  }
});
