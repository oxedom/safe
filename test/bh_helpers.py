# Helpers for driving/debugging the extension with browser-harness (CDP).
# Usage inside a browser-harness heredoc:
#     exec(open('test/bh_helpers.py').read())
import json as _json

EXT_NAME = "Safe (YOLO image blur POC)"
_sessions = {}


def ext_targets():
    return [t for t in cdp("Target.getTargets")["targetInfos"]
            if t["url"].startswith("chrome-extension://")]


def ext_id():
    for t in ext_targets():
        if t["url"].endswith("/background/service-worker.js"):
            return t["url"].split("/")[2]
    raise RuntimeError("Safe service worker target not found (extension not loaded or asleep)")


def _session_for(url_suffix):
    for t in ext_targets():
        if t["url"].endswith(url_suffix):
            tid = t["targetId"]
            if tid not in _sessions:
                _sessions[tid] = cdp("Target.attachToTarget", targetId=tid, flatten=True)["sessionId"]
            return _sessions[tid]
    raise RuntimeError(f"no extension target ending in {url_suffix}")


def ext_eval(url_suffix, expr, timeout=30.0):
    """Evaluate JS in an extension context (service worker, offscreen doc)."""
    sid = _session_for(url_suffix)
    r = cdp("Runtime.evaluate", session_id=sid, _response_timeout=timeout,
            expression=expr, awaitPromise=True, returnByValue=True)
    if "exceptionDetails" in r:
        raise RuntimeError(r["exceptionDetails"].get("exception", {}).get("description") or r["exceptionDetails"])
    return r["result"].get("value")


def sw(expr, timeout=30.0):
    return ext_eval("/background/service-worker.js", expr, timeout)


def offscreen_status():
    return sw("chrome.runtime.sendMessage({what:'offscreen:status'})")


def set_settings(**kw):
    return sw(f"chrome.storage.local.set({_json.dumps(kw)}).then(()=>chrome.storage.local.get(null))")


DUMP_JS = r"""
(() => {
  const out = [];
  // Collect from the document and every open shadow root.
  const els = [];
  const roots = [document];
  while (roots.length) {
    const root = roots.pop();
    els.push(...root.querySelectorAll('[data-safe-state], [data-expect]'));
    for (const e of root.querySelectorAll('*')) { if (e.shadowRoot) { roots.push(e.shadowRoot); } }
  }
  for (const el of els) {
    const r = el.getBoundingClientRect();
    out.push({
      id: el.id || el.getAttribute('data-test') || null,
      tag: el.localName,
      expect: el.getAttribute('data-expect'),
      expectLabel: el.getAttribute('data-expect-label'),
      state: el.getAttribute('data-safe-state'),
      blur: el.getAttribute('data-safe-blur'),
      method: el.getAttribute('data-safe-method'),
      top: el.getAttribute('data-safe-top'),
      reason: el.getAttribute('data-safe-reason'),
      size: [Math.round(r.width), Math.round(r.height)],
      src: (el.currentSrc || el.src || '').slice(0, 90),
    });
  }
  return out;
})()
"""


def dump():
    return js(DUMP_JS)


def print_dump(rows=None, only_expect=False):
    rows = rows if rows is not None else dump()
    for r in rows:
        if only_expect and not r["expect"]:
            continue
        print(f"{str(r['id'])[:22]:22} {r['tag']:7} exp={str(r['expect']):6} state={str(r['state']):8} "
              f"blur={str(r['blur']):8} via={str(r['method']):7} top={str(r['top']):22} {r['size']} {r['reason'] or ''}")


def reload_ext(wait_s=12):
    """chrome.runtime.reload() then wait until the offscreen model reports ready."""
    import time as _t
    try:
        sw("chrome.runtime.reload()", timeout=2)
    except Exception:
        pass
    _sessions.clear()
    deadline = _t.time() + wait_s
    while _t.time() < deadline:
        _t.sleep(1)
        try:
            st = offscreen_status()
            if st and (st.get("ready") or st.get("error")):
                return st
        except Exception:
            _sessions.clear()
    return None


def save_last_capture(path):
    """Write the last captureVisibleTab screenshot with every crop rect drawn on it."""
    import base64 as _b64, subprocess as _sp
    lc = sw("chrome.runtime.sendMessage({what:'offscreen:lastCapture'})")
    if not lc:
        print("no capture yet")
        return None
    raw = path + ".raw.png"
    open(raw, "wb").write(_b64.b64decode(lc["dataUrl"].split(",", 1)[1]))
    draw = []
    for r in lc["results"]:
        if r.get("crop"):
            x, y, w, h = r["crop"]
            label = f"#{r['id']} {r['top']['label'] + ' ' + str(r['top']['score']) if r.get('top') else 'none'}"
            draw += ["-stroke", "red", "-strokewidth", "3", "-fill", "none", "-draw", f"rectangle {x},{y} {x+w},{y+h}",
                     "-stroke", "none", "-fill", "red", "-pointsize", "18", "-annotate", f"+{x+6}+{y+22}", label]
    _sp.run(["magick", raw] + draw + [path], check=True)
    print({k: lc[k] for k in ("viewport", "targets")}, lc["results"])
    return path


def content_eval(expr, frame_id=None):
    """Evaluate in the extension's isolated world of the current tab (main frame by default)."""
    drain_events()
    cdp("Runtime.disable")
    cdp("Runtime.enable")
    import time as _t
    _t.sleep(0.3)
    ctxs = []
    for e in drain_events():
        if e.get("method") == "Runtime.executionContextCreated":
            c = e["params"]["context"]
            aux = c.get("auxData", {})
            if c.get("name") == EXT_NAME and aux.get("type") == "isolated":
                ctxs.append(c)
    for c in reversed(ctxs):  # newest first; skip stale worlds from earlier extension versions
        r = cdp("Runtime.evaluate", contextId=c["id"], returnByValue=True, awaitPromise=True,
                expression=f"(globalThis.__safeContent && __safeContent.alive()) ? ({expr}) : '__stale__'")
        v = r.get("result", {}).get("value")
        if v != "__stale__":
            return v
    return None
