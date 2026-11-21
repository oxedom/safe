# Safe

[MIT license](LICENSE) · [Privacy](PRIVACY.md) · [Contributing](CONTRIBUTING.md)

A Chrome Manifest V3 proof of concept that blurs images containing detected objects.

On every page, images rendered at **≥100×100 CSS px** are run through a bundled
**YOLOv7 (COCO, 80 classes)** TF.js model. Images with a detection above the confidence
threshold get a CSS blur. Everything runs locally: the model, TF.js and every script
ship inside the extension (MV3 forbids remotely hosted code).

The pipeline does not depend on the model. The model is one detector file, so an
ads or political-content classifier can be added later as another detector (see
[Adding a model](#adding-a-model)).

## Load it

Use Chrome 116 or newer, a current Node.js LTS release, pnpm 12.21.0, Bash and curl.

```bash
pnpm install --frozen-lockfile
pnpm run setup        # downloads TF.js runtime files, model weights and upstream licenses
```

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `extension/`.
3. After editing code, click the reload icon on the card, or run `chrome.runtime.reload()`
   in the service worker console. Open tabs get the new content script injected
   automatically (`onInstalled` in the service worker). Reloading them is still the
   cleanest way to start fresh.

`extension/vendor/` and `extension/models/` (≈26 MB) are git-ignored and produced by
`pnpm run setup`. The model download uses a pinned public revision. Set
`SAFE_MODEL_DIR` to use an existing compatible model directory.

Safe's original code is MIT licensed. The downloaded model, runtime dependencies
and optional test photographs have separate terms; see
[Third-party materials](THIRD_PARTY_NOTICES.md) before redistributing a build.

## Use it

The toolbar popup has:

- an **on/off** toggle
- a **confidence threshold** slider. The default is 0.35 (YOLO's usual is 0.25).
  Changing it re-scores the cached results instantly, with no new inference.
- counts for the current tab: scanned / flagged / pending / skipped (<100px), plus
  fetch-vs-capture counts, errors, revealed images and frames. The badge shows the
  flagged count.
- **Debug mode**: colored outlines (green clean, red flagged, amber pending, gray
  error). Hovering over a scanned image shows its top class and score, the
  runner-up classes, the method and any fallback reason. **Clicking a blurred
  image reveals it**; clicking again blurs it back.
- **Blur while scanning**: qualifying images stay blurred (grayscale) until their
  verdict arrives, so unscanned content never flashes up.
- **Backend**: auto (WebGPU, then WebGL), WebGPU, WebGL or CPU.

## Architecture

```
 page (every frame, document_start)            extension
┌──────────────────────────────┐   classify(url)   ┌────────────────────┐  offscreen:classifyUrl  ┌──────────────────────────────┐
│ content/content.js           │ ────────────────▶ │ background/        │ ──────────────────────▶ │ offscreen/offscreen.html     │
│  MutationObserver (batched)  │ ◀──── verdict ─── │  service-worker.js │ ◀────── verdict ─────── │  TF.js + YOLOv7, loaded once │
│  ResizeObserver: ≥100px gate │                   │  router            │                         │  fetch → createImageBitmap   │
│  IntersectionObserver: scan  │  requestCapture   │  offscreen life-   │  offscreen:classify-    │  letterbox 640 → NCHW 0..1   │
│   1.5 viewports ahead        │ ────────────────▶ │   cycle            │   Capture (1 shot,      │  decode obj×cls on GPU       │
│  data-safe-* attrs + CSS     │ ◀ captureMeasure  │  captureVisibleTab │   N crops)              │  serial GPU queue, 6 fetches │
│  debug tooltip/reveal        │ ─ rects ────────▶ │   scheduler ≤2/s   │ ──────────────────────▶ │  LRU cache by URL (4000)     │
└──────────────────────────────┘ ◀ captureResults  │  stats + badge     │                         └──────────────────────────────┘
                                                   └────────────────────┘
```

| File | Role |
|---|---|
| `extension/manifest.json` | MV3. Content script on `<all_urls>`, `all_frames`, `document_start`, `match_origin_as_fallback`. Broad permissions on purpose for the POC. |
| `extension/content/content.js` | Finds `<img>` (src/srcset/`currentSrc`, `<picture>`, native and JS lazy loading, added later), `<canvas>`, and elements with `background-image: url()`, including inside **open shadow roots**. Tracks per-element state and applies verdicts. |
| `extension/background/service-worker.js` | Routes messages, creates the offscreen document on demand, runs the capture scheduler, keeps per-tab stats in `storage.session`, sets the badge, and injects the blur CSS with `origin: 'USER'`. |
| `extension/offscreen/offscreen.js` | Picks a backend (WebGPU, then WebGL, then CPU), loads and warms up the model once, fetches and decodes images, crops captures, runs the inference queue, and holds the URL cache and a log ring. |
| `extension/offscreen/detectors/yolov7.js` | The model: letterbox preprocessing, objectness × class decoding on the GPU, top-K + class-aware NMS, boxes mapped back to source pixels. |
| `extension/popup/` | The UI above. `popup.html?tab=<id>` opens it as a page for a given tab (handy for debugging and screenshots). |
| `extension/shared/defaults.js` | Default settings plus the blur and debug CSS, shared by every context. |

### Element states

Each element's state is written to DOM attributes, so it can be checked from
DevTools or CDP:

| attribute | values |
|---|---|
| `data-safe-state` | `small` (<100px, never sent) · `waiting` (not near the viewport yet, not loaded, or a lazy-load placeholder) · `pending` · `capture` (waiting for the screenshot fallback) · `clean` · `flagged` · `error` |
| `data-safe-blur` | `flagged` or `pending`. If present, the element is blurred. |
| `data-safe-method` | `fetch` or `capture`, the path that produced the verdict |
| `data-safe-top` | `label:score` or `none` |
| `data-safe-reason` | why the fetch path failed (`unsupported-scheme:blob`, `http-403`, `canvas`, …) |
| `data-safe-id` | per-document element id, used in the offscreen log (`#id`) |

### Getting around the cross-origin canvas problem

1. **Primary: fetch.** The offscreen document (an extension page holding the
   `<all_urls>` host permission) `fetch`es the image URL itself, so page CORS rules
   don't apply. The request also carries the site's first-party cookies (verified
   on the session-gated test image). It then decodes with `createImageBitmap`,
   falling back to `<img>` for SVG.
   As soon as layout confirms a nearby image is at least 100×100 CSS px, its
   scan starts **without waiting for the page's `load` event**. For an unfinished
   `srcset`/`<picture>` image, `webRequest.onBeforeRequest` supplies the browser's
   chosen URL, scoped to the tab, frame and document. This observer only records
   URLs: small, hidden and distant images do not trigger extension downloads or
   inference. Memory-cache hits invisible to `webRequest`, or ambiguous request
   history matching multiple candidates, use `currentSrc` at load instead.
   Source changes invalidate older replies. If an early fetch
   fails, screenshot fallback waits until the page has loaded the image.
2. **Fallback: `captureVisibleTab`.** Used for `blob:` URLs, canvases, and anything
   the fetch can't get (HTTP 4xx from hotlink protection, network errors, decode
   failures):
   - The content script marks the element `capture`. Once ≥50% of it is on screen,
     it asks the service worker for a capture.
   - The service worker rate-limits to one screenshot every 550 ms (Chrome allows
     about 2 per second). Right before shooting, it asks the page to **measure**
     every waiting element, so the rects match the screenshot, then takes **one**
     screenshot.
   - The offscreen document crops all the rects, up to 12 per shot. The scale comes
     from `screenshot.width / innerWidth`, which accounts for both devicePixelRatio
     and zoom. It was verified at dpr 1.125.
   - Elements blurred by "blur while scanning" are unblurred for that one frame, and
     debug outlines and the tooltip are hidden.
   - Results come back tagged with a per-document instance token, so a navigation
     between measuring and results can't apply one document's verdicts to another
     (this bug was found and fixed during testing).
   - Canvases that come back clean are captured twice more (after 1.5 s and 5 s),
     in case the page had not drawn into them yet.

The method behind each verdict is logged in three places: the offscreen console
(`[safe] fetch ok person 0.89 …`), the `data-safe-method` attribute, and the page
console when debug mode is on.

## Debugging

| What | Where |
|---|---|
| Service worker console | `chrome://extensions`, then *Inspect views: service worker* |
| Model / queue / cache / fetch log | *Inspect views: offscreen/offscreen.html*. In the service worker console, `await chrome.runtime.sendMessage({what:'offscreen:status'})` returns backend, avg ms, queue, cache and the last 80 log entries. |
| Last screenshot used for crops | `await chrome.runtime.sendMessage({what:'offscreen:lastCapture'})` in the service worker console. `save_last_capture(path)` in `test/bh_helpers.py` draws the crop rects onto it. |
| Per-element state | DevTools Elements: the `data-safe-*` attributes. In debug mode, hover the image. |
| Content-script internals | In the page DevTools console, switch the context dropdown to *Safe (YOLO image blur POC)* and run `__safeContent.inspect($0)`. |
| Recorded errors | `chrome://extensions`, *Errors* on the card |

`test/bh_helpers.py` wraps all of this for
[browser-harness](https://github.com/browser-use/browser-harness) (CDP):
`offscreen_status()`, `set_settings(...)`, `reload_ext()`, `dump()`, `content_eval(...)`,
`save_last_capture(...)`.

## Testing

The local server needs Python 3. Browser tests also need ImageMagick and
[browser-harness](https://github.com/browser-use/browser-harness), connected to
Chrome with the unpacked extension loaded. Run commands from the repository root.

```bash
pnpm run check
pnpm run setup:fixtures                # optional third-party test photos; requires ImageMagick
pnpm run serve                         # http://localhost:8000 (test page) + http://127.0.0.1:8001 ("other domain")
pnpm run verify                        # browser-harness < test/verify.py  -> PASS/FAIL per element
pnpm run verify:early                  # verdict-before-load + source-change/size/fallback regressions
SAFE_URL=http://localhost:8000 SAFE_LABEL=local pnpm run benchmark
SAFE_BLUR_PENDING=1 SAFE_BACKEND=webgl browser-harness < test/verify.py
SAFE_URL=http://localhost:8000 browser-harness < test/probe_site.py
```

`test/site/index.html` marks each case with `data-expect` (`blur` | `clean` | `skip`)
and, where useful, `data-expect-label`. That way a test fails if an image was
blurred for the wrong reason. Cases:
- clear positives (people, bus, dog, dog + bike + truck) and abstract-texture
  negatives
- cross-origin images with no CORS headers (positive and negative)
- `srcset`, `<picture><source>`, native `loading=lazy`, and a JS `data-src` lazy loader
- images added 2 s after load, a CSS background (positive and negative), a
  session-cookie-gated image, a hotlink-protected image (403 to the extension),
  a `blob:` URL, canvases (photo and gradient), an open shadow root, and a
  cross-origin iframe
- a 64 px icon, a large photo shown at 80 px, and a `display:none` image. The
  server log (`Sec-Fetch-Dest: empty` = extension fetch) proves these were never
  fetched by the extension.

`test/early_start.py` uses `/delayed/` fixtures whose page requests take 1.5 s,
while extension fetches finish normally. It verifies that plain, `srcset` and
`<picture>` verdicts arrive before page load, that only the selected responsive
candidate is fetched, and that source swaps and shrinking images reject stale
replies. Small/hidden images must produce neither fetches nor inference; a fetch
failure must wait for real page pixels before capture. These are controlled
timing tests, not a guarantee that every real-site verdict precedes paint.

`test/benchmark_site.py` measures the page supplied in `SAFE_URL`. It warms the
model, disables the page and offscreen HTTP caches, clears the verdict cache per
round, and uses a fixed 1280×900 viewport. Reports contain image-request →
scan-start → verdict timings and verdict delay after `load`, with separate
summaries for visible images. `load` is a timing reference, not a measurement of
first paint. Performance depends on the page, hardware, backend and queue.

Reports under `test/benchmarks/`, screenshots under `test/screenshots/`, and the
local server log are ignored by Git. Benchmark reports omit image URLs and page
content. The probe tool prints detection summaries; screenshots require an
explicit `SAFE_CAPTURE=1`. Use the local test page or other public pages, and
review all generated artifacts before sharing them.

## What doesn't work (yet) and why

- **Unscanned content can still flash before its verdict.** Scans now start during
  page image loading, but fast page loads, a cold model or a busy queue can still
  beat inference. Turn on *Blur while scanning* to blur first and unblur when clean.
- **Background tabs are scanned only once they're shown.** Chrome doesn't run
  ResizeObserver or IntersectionObserver in hidden tabs, and `captureVisibleTab`
  only sees the visible tab.
- **The capture fallback only works in the top frame.** A subframe's rects are
  relative to that frame, not to the tab screenshot. Fetch-path failures inside
  iframes end up as `error`. Captures also need the element at least half on screen.
  The screenshot includes whatever overlays sit on top of the element.
- **Cross-origin iframes get no scan-ahead.** Chrome ignores `rootMargin` for them
  and throttles their rendering off-screen, so their images are scanned only when
  visible.
- **Hotlink-protected images fail the fetch path,** because the extension's fetch
  sends no page Referer. They fall back to capture. A `declarativeNetRequest` rule
  could add the Referer later.
- **Not covered:** closed shadow roots, CSS `::before`/`::after` backgrounds,
  `<video>` posters, `<svg><image>`, and `image-set()`.
- **Background-image detection relies on `getComputedStyle`.** Elements are walked
  at DOMContentLoaded, at load, and on inline `style` changes. A class change
  that adds a background later is not tracked.
- **Model behaviour:** COCO object classes only, with false positives and missed
  detections. At the default 0.35, photos containing people are often flagged.
  This is an experimental object filter, not a reliable content-safety classifier.
- **Performance varies:** inference uses 640×640 inputs, and the cache only lives
  in memory (it clears when the offscreen document restarts).

## Adding a model

A detector is a classic script that registers itself on `self.SafeDetectors`:

```js
SafeDetectors['my-model'] = {
  id: 'my-model', version: 1,
  async load(tf, modelUrl) { /* load + warm up */ },
  async classify(source, width, height) {      // any CanvasImageSource
    return { top: { label, score } | null, scores: { label: score }, detections: [] };
  },
};
```

Add it to `offscreen/offscreen.html` and point `SAFE.DETECTOR_ID` at it. Everything
else stays the same: discovery, size gate, fetch/capture, cache key
(`id@version|url`), threshold, blur, popup and debug UI. Possible next steps:
- several detectors in parallel (e.g. ads + people), each with its own threshold
- per-label policies (e.g. blur only `person`), using `result.scores`
- a text pipeline beside the image one, reusing the same content-script
  discovery and batching pattern
