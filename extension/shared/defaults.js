// Shared constants. Loaded as a classic script by every context
// (content script, service worker, offscreen document, popup).
(function (root) {
  'use strict';
  if (root.SAFE) { return; }
  root.SAFE = Object.freeze({
    // Persisted in chrome.storage.local.
    DEFAULT_SETTINGS: Object.freeze({
      enabled: true,
      threshold: 0.35,     // blur when top detection score >= threshold (YOLO's usual conf is 0.25)
      debug: false,        // outlines, hover tooltip, click-to-reveal, console logs
      blurPending: false,  // blur qualifying images until their verdict arrives
      backend: 'auto',     // auto | webgpu | webgl | cpu
    }),
    MIN_RENDERED_PX: 100,  // both width and height, CSS px
    DETECTOR_ID: 'yolov7-coco',

    // Injected twice (uBO pattern): adopted by the content script for an
    // immediate effect, and by the service worker via scripting.insertCSS with
    // origin USER, which page CSS cannot override even with !important.
    BLUR_CSS: `
[data-safe-blur] {
  filter: blur(24px) saturate(0.4) !important;
  clip-path: inset(0) !important;
  transition: filter .12s ease-out !important;
}
[data-safe-blur="pending"] { filter: blur(24px) grayscale(1) !important; }
[data-safe-capturing] { filter: none !important; transition: none !important; }
`,
    // Debug mode only (adopted stylesheet, author origin).
    DEBUG_CSS: `
[data-safe-state="pending"], [data-safe-state="capture"] { outline: 3px dashed #f59e0b !important; outline-offset: -3px !important; }
[data-safe-state="clean"]   { outline: 3px solid #22c55e !important; outline-offset: -3px !important; }
[data-safe-state="flagged"] { outline: 3px solid #ef4444 !important; outline-offset: -3px !important; cursor: help !important; }
[data-safe-state="error"]   { outline: 3px dotted #6b7280 !important; outline-offset: -3px !important; }
[data-safe-revealed]        { outline-style: double !important; }
html[data-safe-capturing-page] [data-safe-state] { outline: none !important; }
`,
  });
})(globalThis);
