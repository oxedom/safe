# End-to-end check of the extension against test/site/index.html.
#
#   python3 test/serve.py &            # in another shell
#   browser-harness < test/verify.py
#
# Needs: the unpacked extension loaded in the Chrome that browser-harness drives.
# The test tab is brought to the front: hidden tabs do not run layout
# observers, and captureVisibleTab only sees the visible tab.
import os
import re
import time
from pathlib import Path

exec(Path('test/bh_helpers.py').read_text())

ROOT = Path.cwd() / 'test'
(ROOT / 'screenshots').mkdir(exist_ok=True)
URL = 'http://localhost:8000/'
FRAME = '127.0.0.1:8001/frame.html'
NEVER_FETCH = ['icon-dog-64.png', 'zidane.jpg?small', 'giraffe.jpg?hidden']

# Variants:  SAFE_BLUR_PENDING=1  SAFE_BACKEND=webgl|webgpu|auto  browser-harness < test/verify.py
BLUR_PENDING = os.environ.get('SAFE_BLUR_PENDING') == '1'
BACKEND = os.environ.get('SAFE_BACKEND', 'auto')

# Fresh run: default settings + debug, empty verdict cache, empty server log.
prev_backend = sw("chrome.storage.local.get('backend').then(s => s.backend)")
set_settings(enabled=True, threshold=0.35, debug=True, blurPending=BLUR_PENDING, backend=BACKEND)
if prev_backend != BACKEND:
    time.sleep(1)  # the service worker recreates the offscreen document
    for _ in range(30):
        try:
            if offscreen_status().get('ready'):
                break
        except Exception:
            _sessions.clear()
        time.sleep(0.5)
sw("chrome.runtime.sendMessage({what:'offscreen:clearCache'}).catch(()=>null)")
open(os.path.join(ROOT, 'server.log'), 'w').close()

tab = next((t for t in list_tabs() if t['url'].split('?')[0].rstrip('/') == URL.rstrip('/')), None)
if tab:
    switch_tab(tab['targetId'])
    js('location.reload()')
else:
    new_tab(URL)
wait_for_load()
activate_tab(current_tab()['targetId'])
if BLUR_PENDING:
    # Right after load, qualifying images must already be blurred as "pending".
    time.sleep(0.4)
    early = [r for r in dump() if r['expect'] in ('blur', 'clean') and r['state'] in ('pending', 'waiting', 'capture')]
    unblurred = [r['id'] for r in early if r['blur'] is None and r['size'][0] >= 100]
    print(f"blurPending: {len(early)} elements in flight at t+0.4s, unblurred among them: {unblurred or 'none'}")
time.sleep(4)

# Walk the page so lazy/late content and the iframe come into range.
height = js('document.documentElement.scrollHeight')
for y in range(0, height, 700):
    js(f'window.scrollTo(0,{y})')
    time.sleep(0.7)
js("document.getElementById('xframe').scrollIntoView({block:'center'})")
time.sleep(2.5)
js('window.scrollTo(0,0)')


def frame_rows():
    sid = cdp('Target.attachToTarget', targetId=iframe_target(FRAME), flatten=True)['sessionId']
    return cdp('Runtime.evaluate', session_id=sid, expression=DUMP_JS, returnByValue=True)['result']['value']


# Wait for the queue to drain.
for _ in range(30):
    rows = [r for r in dump() + frame_rows() if r['expect']]
    busy = [r['id'] for r in rows if r['state'] in ('pending', 'capture', 'waiting')]
    if not busy:
        break
    time.sleep(1)

failures = []
for r in rows:
    exp, state, blurred = r['expect'], r['state'], r['blur'] == 'flagged'
    ok = ((exp == 'blur' and state == 'flagged' and blurred) or
          (exp == 'clean' and state == 'clean' and not blurred) or
          (exp == 'skip' and state in (None, 'small') and not r['method']))
    # Guard against passing for the wrong reason (e.g. a crop of a neighbour).
    if ok and r.get('expectLabel') and not (r['top'] or '').startswith(r['expectLabel'] + ':'):
        ok = False
    if not ok:
        failures.append(r['id'])
    print(f"{'PASS' if ok else 'FAIL'}  ", end='')
    print_dump([r])

# Server-side proof that small images were never fetched by the extension
# (extension fetches arrive with Sec-Fetch-Dest: empty, Sec-Fetch-Site: none).
log = open(os.path.join(ROOT, 'server.log')).read().splitlines()
ext_fetches = [l for l in log if 'dest=empty' in l and 'site=none' in l]
for name in NEVER_FETCH:
    hit = [l for l in ext_fetches if name in l]
    print(f"{'FAIL' if hit else 'PASS'}  server log: extension never fetched {name}")
    if hit:
        failures.append(name)

methods = {}
for r in rows:
    if r['method']:
        methods[r['method']] = methods.get(r['method'], 0) + 1
st = offscreen_status()
st.pop('log', None)
print('\nmethods:', methods)
print('model:', {k: st[k] for k in ('backend', 'ready', 'inferences', 'avgInferMs', 'cacheSize')}, 'blurPending:', BLUR_PENDING)
print(f"\n{len(rows) - len([f for f in failures if f in [r['id'] for r in rows]])}/{len(rows)} elements as expected; "
      f"{'ALL PASS' if not failures else 'FAILURES: ' + ', '.join(failures)}")
capture_screenshot(os.path.join(ROOT, 'screenshots', 'verify-top.png'))
if failures:
    raise RuntimeError('Failed: ' + ', '.join(failures))
