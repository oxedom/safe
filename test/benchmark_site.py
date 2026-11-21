# Real-site benchmark: SAFE_URL=http://localhost:8000 SAFE_LABEL=local
# browser-harness < test/benchmark_site.py
# Records only aggregate timings and anonymous per-image measurements.
import collections
import hashlib
import json
import os
import re
import statistics
import time
from pathlib import Path

root = Path.cwd()
exec((root / 'test/bh_helpers.py').read_text())
url = os.environ['SAFE_URL']
label = re.sub(r'[^a-zA-Z0-9_-]', '-', os.environ.get('SAFE_LABEL', 'early'))
site = re.sub(r'[^a-zA-Z0-9_-]', '-', os.environ.get('SAFE_SITE', 'site'))[:40]
rounds = int(os.environ.get('SAFE_ROUNDS', '2'))
original = sw('chrome.storage.local.get(null)')
tab = next((t for t in list_tabs() if t['url'].split('?')[0].rstrip('/') == url.split('?')[0].rstrip('/')), None)
if tab:
    switch_tab(tab['targetId'])
else:
    new_tab(url)
activate_tab(current_tab()['targetId'])
cdp('Page.enable')
cdp('Network.enable')
cdp('Network.setCacheDisabled', cacheDisabled=True)
offscreen_session = _session_for('/offscreen/offscreen.html')
cdp('Network.enable', session_id=offscreen_session)
cdp('Network.setCacheDisabled', session_id=offscreen_session, cacheDisabled=True)
cdp('Emulation.setDeviceMetricsOverride', width=1280, height=900, deviceScaleFactor=1.125, mobile=False)
injection = cdp('Page.addScriptToEvaluateOnNewDocument', source=(root / 'test/benchmark.js').read_text())['identifier']
results = []


try:
    set_settings(enabled=True, threshold=0.35, debug=False, blurPending=False)
    for run in range(rounds):
        for _ in range(100):
            status = offscreen_status()
            if status['ready'] and not status['queued'] and not status['inflight']:
                break
            time.sleep(0.1)
        sw("chrome.runtime.sendMessage({what:'offscreen:clearCache'})")
        goto_url(url)
        wait_for_load()
        time.sleep(3)
        for _ in range(3):
            scroll(640, 450, dy=650)
            time.sleep(2)
        time.sleep(2)
        rows = js('__safeBench.summary()')
        results.extend(rows)
        print(f'{label} {site} round {run + 1}: {len(rows)} image scans; '
              f"{dict(collections.Counter(r['state'] for r in rows))}", flush=True)
finally:
    js('window.__safeBench?.stop()')
    cdp('Page.removeScriptToEvaluateOnNewDocument', identifier=injection)
    cdp('Network.setCacheDisabled', cacheDisabled=False)
    cdp('Network.setCacheDisabled', session_id=offscreen_session, cacheDisabled=False)
    cdp('Emulation.clearDeviceMetricsOverride')
    sw(f'chrome.storage.local.set({json.dumps(original)})')


def summary(rows):
    valid = [r for r in rows if r['verdictMs'] is not None and r['state'] in ('clean', 'flagged')]
    out = {'scans': len(rows), 'timedVerdicts': len(valid),
           'beforeLoad': sum(r['beforeLoad'] is True for r in valid),
           'methods': dict(collections.Counter(r.get('method') for r in rows)),
           'errors': sum(r['state'] == 'error' for r in rows)}
    for key in ('pageLoadMs', 'scanDelayMs', 'verdictMs', 'processingMs', 'afterLoadMs'):
        values = sorted(r[key] for r in valid if r[key] is not None)
        if values:
            out[key] = {'median': round(statistics.median(values)), 'p90': values[min(len(values)-1, int(len(values)*0.9))]}
    return out


report = {'label': label, 'site': site, 'rounds': rounds, 'backend': offscreen_status()['backend'],
          'contentSha256': hashlib.sha256((root / 'extension/content/content.js').read_bytes()).hexdigest()[:12],
          'browser': cdp('Browser.getVersion')['product'],
          'all': summary(results), 'visible': summary([r for r in results if r['visible']]),
          'initialVisible': summary([r for r in results if r['visible'] and r['initial']]), 'rows': results}
directory = root / 'test/benchmarks'
directory.mkdir(exist_ok=True)
(directory / f'{label}-{site}.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({k: v for k, v in report.items() if k != 'rows'}, indent=2))
if not report['all']['timedVerdicts']:
    raise RuntimeError('No image verdicts with resource timing; this run cannot establish performance')
