# Deterministic early-start regression checks in the real Chrome extension.
# Run the local test server, then: browser-harness < test/early_start.py
import json
from pathlib import Path

exec(Path('test/bh_helpers.py').read_text())

root = Path.cwd() / 'test'
url = 'http://localhost:8000/early.html'
original_settings = sw('chrome.storage.local.get(null)')
failures = []

CASE_JS = r'''async config => {
  document.body.replaceChildren();
  const img = new Image();
  img.id = 'case';
  const token = `${Date.now()}-${Math.random()}`;
  const path = (name, suffix='') => `/delayed/${name}?early=${token}${suffix}`;
  const oldUrl = path('bus.jpg', '&ext_ms=600');
  const wanted = config.swap ? path('texture-swirl.jpg') : config.picture ? path('eagle.jpg') :
    path(config.high ? 'bus-800.jpg' : 'bus.jpg', config.capture ? '&deny_ext=1' : '');
  const fallback = path('texture-hex.png', '&fallback=1');
  let resolveLoad;
  const loaded = new Promise(r => resolveLoad = r);
  const start = performance.now();
  let verdictAt = null, loadedAt = null, beforeLoad = false;
  const observer = new MutationObserver(() => {
    const state = img.getAttribute('data-safe-state');
    if ((state === 'clean' || state === 'flagged') && verdictAt === null) {
      verdictAt = performance.now() - start;
      beforeLoad = !img.complete;
    }
  });
  if (config.ambiguous) {
    // Both srcset candidates have been requested in this document. Without an
    // element id, webRequest history alone cannot establish this img's choice.
    await Promise.all([wanted, path('bus-800.jpg', '&unselected=1')].map(src => new Promise(resolve => {
      const warm = new Image(); warm.onload = warm.onerror = resolve; warm.src = src;
    })));
  }
  observer.observe(img, { attributes: true, attributeFilter: ['data-safe-state'] });
  img.onload = () => { loadedAt = performance.now() - start; resolveLoad(); };
  img.onerror = () => resolveLoad();
  if (config.small) { img.style.width = '80px'; img.style.height = '80px'; }
  if (config.hidden) { img.style.display = 'none'; }
  if (config.responsive) {
    img.src = fallback;
    img.srcset = `${path('bus.jpg', config.high ? '&unselected=1' : '')} 400w, ${path('bus-800.jpg', config.high ? '' : '&unselected=1')} 800w`;
    img.sizes = config.high ? '900px' : '260px';
  } else if (config.picture) {
    const picture = document.createElement('picture');
    const source = document.createElement('source');
    source.srcset = config.swap ? oldUrl : wanted;
    source.media = '(min-width: 1px)';
    picture.append(source, img);
    img.src = fallback;
    document.body.append(picture);
  } else {
    img.src = config.swap || config.shrink ? oldUrl : wanted;
  }
  if (!img.isConnected) { document.body.append(img); }
  if (config.swap || config.shrink) {
    // Change only after the extension has started, while its fetch is delayed.
    for (let i=0; i<100 && img.getAttribute('data-safe-state') !== 'pending'; i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    await new Promise(r => setTimeout(r, 80));
    if (config.swap) {
      if (config.picture) { img.parentElement.querySelector('source').srcset = wanted; }
      else { img.src = wanted; }
    }
    else { img.style.width = '80px'; img.style.height = '80px'; }
  }
  await Promise.race([loaded, new Promise((_, reject) => setTimeout(() => reject(Error('image load timeout')), 8000))]);
  for (let i=0; i<200; i++) {
    const state = img.getAttribute('data-safe-state');
    if (['clean', 'flagged', 'error'].includes(state) ||
        (state === 'small' && (config.small || config.hidden || config.shrink))) { break; }
    await new Promise(r => setTimeout(r, 10));
  }
  // Allow an old request's response to arrive after the new one.
  if (config.swap || config.shrink) { await new Promise(r => setTimeout(r, 700)); }
  observer.disconnect();
  return { state: img.getAttribute('data-safe-state'), method: img.getAttribute('data-safe-method'),
    top: img.getAttribute('data-safe-top'), currentSrc: img.currentSrc,
    wanted: config.ambiguous ? img.currentSrc : new URL(wanted, location.href).href,
    beforeLoad, verdictMs: Math.round(verdictAt), loadMs: Math.round(loadedAt), token };
}'''

try:
    set_settings(enabled=True, threshold=0.35, debug=False, blurPending=False)
    tab = next((t for t in list_tabs() if t['url'] == url), None)
    if tab:
        switch_tab(tab['targetId'])
        js('location.reload()')
    else:
        new_tab(url)
    wait_for_load()
    # Timing and layout observer tests need an actively rendered tab.
    activate_tab(current_tab()['targetId'])
    sw("chrome.runtime.sendMessage({what:'offscreen:clearCache'})")
    cases = [
        ('plain URL before load', {}, 'flagged'),
        ('srcset chosen URL before load', {'responsive': True}, 'flagged'),
        ('srcset larger candidate before load', {'responsive': True, 'high': True}, 'flagged'),
        ('ambiguous srcset waits for currentSrc', {'responsive': True, 'ambiguous': True}, 'flagged'),
        ('picture chosen URL before load', {'picture': True}, 'flagged'),
        ('under 100px', {'small': True}, 'small'),
        ('hidden image', {'hidden': True}, 'small'),
        ('src swap during fetch', {'swap': True}, 'clean'),
        ('picture source swap during fetch', {'picture': True, 'swap': True}, 'clean'),
        ('shrink during fetch', {'shrink': True}, 'small'),
        ('early fetch failure waits for capture pixels', {'capture': True}, 'flagged'),
    ]
    for name, config, expected in cases:
        inferences_before = offscreen_status()['inferences']
        result = js(f'({CASE_JS})({json.dumps(config)})')
        ok = result['state'] == expected
        if expected != 'small':
            ok = ok and result['method'] == ('capture' if config.get('capture') else 'fetch')
            ok = ok and result['currentSrc'] == result['wanted']
            if config.get('capture') or config.get('ambiguous'):
                ok = ok and not result['beforeLoad'] and result['verdictMs'] >= result['loadMs']
            else:
                ok = ok and result['beforeLoad'] and result['verdictMs'] < result['loadMs']
        else:
            ok = ok and result['method'] is None
        if config.get('picture') and not config.get('swap'):
            ok = ok and (result['top'] or '').startswith('bird:')
        log = (root / 'server.log').read_text().splitlines()
        fetches = [line for line in log if 'dest=empty' in line and result['token'] in line]
        if config.get('small') or config.get('hidden'):
            ok = ok and not fetches
            ok = ok and offscreen_status()['inferences'] == inferences_before
        ok = ok and not any('fallback=1' in line or (not config.get('ambiguous') and 'unselected=1' in line) for line in fetches)
        print(f"{'PASS' if ok else 'FAIL'} {name}: {json.dumps(result)}")
        if not ok:
            failures.append(name)
finally:
    sw(f'chrome.storage.local.set({json.dumps(original_settings)})')

print(f'{len(cases) - len(failures)}/{len(cases)} early-start checks passed')
if failures:
    raise RuntimeError('Failed: ' + ', '.join(failures))
