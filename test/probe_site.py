# Probe a real site:  SAFE_URL=https://... browser-harness < test/probe_site.py
# Opens the URL in a new foreground tab, scrolls a few screens, then reports
# what the extension did. Set SAFE_CAPTURE=1 to save screenshots locally.
import collections
import os
import re
import time
from pathlib import Path

exec(Path('test/bh_helpers.py').read_text())

URL = os.environ['SAFE_URL']
NAME = re.sub(r'[^a-zA-Z0-9_-]', '-', os.environ.get('SAFE_NAME', 'site'))[:40]
SCREENS = int(os.environ.get('SAFE_SCREENS', '4'))
SHOTS = Path.cwd() / 'test/screenshots'
CAPTURE = os.environ.get('SAFE_CAPTURE') == '1'
if CAPTURE:
    SHOTS.mkdir(exist_ok=True)

tab = next((t for t in list_tabs() if t['url'].startswith(URL)), None)
if tab:
    switch_tab(tab['targetId'])
    goto_url(URL)
else:
    new_tab(URL)
wait_for_load()
activate_tab(current_tab()['targetId'])
time.sleep(5)
if CAPTURE:
    capture_screenshot(str(SHOTS / f'site-{NAME}-0.png'))
for i in range(1, SCREENS + 1):
    js('window.scrollBy(0, innerHeight * 0.9)')
    time.sleep(2.5)
time.sleep(4)
if CAPTURE:
    capture_screenshot(str(SHOTS / f'site-{NAME}-{SCREENS}.png'))

rows = dump()
states = collections.Counter(r['state'] for r in rows)
methods = collections.Counter(r['method'] for r in rows if r['method'])
tags = collections.Counter(r['tag'] for r in rows)
reasons = collections.Counter(re.sub(r'[0-9a-f-]{20,}', '…', r['reason'] or '')[:60] for r in rows if r['reason'])
labels = collections.Counter((r['top'] or '').split(':')[0] for r in rows if r['state'] == 'flagged')
print('tracked:', len(rows), dict(tags))
print('states:', dict(states))
print('methods:', dict(methods))
print('flagged labels:', dict(labels.most_common(8)))
print('fallback/error reasons:', dict(reasons.most_common(8)))
st = offscreen_status()
st.pop('log', None)
print('model:', {k: st[k] for k in ('backend', 'inferences', 'avgInferMs', 'queued', 'cacheSize')})
