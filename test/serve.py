#!/usr/bin/env python3
"""Local test server for the Safe extension.

  http://localhost:8000/   test/site        the test page (origin A)
  http://127.0.0.1:8001/   test/site/other  "another domain" (origin B), no CORS headers

Special routes on origin A:
  /private/<file>   403 unless the request carries cookie session=ok  (page sets it)
  /hotlink/<file>   403 unless Referer starts with http://localhost:8000/

Every request is logged with Sec-Fetch-Dest and Origin, so it is visible whether
an image was loaded by the page (dest=image) or fetched by the extension
(dest=empty, origin=chrome-extension://...). Log: test/server.log
"""
import http.server
import os
import sys
import threading
import time
from functools import partial
from urllib.parse import parse_qs, urlsplit

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(ROOT, "site")
LOG = open(os.path.join(ROOT, "server.log"), "a", buffering=1)


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _log(self, status):
        h = self.headers
        LOG.write(f"{self.server.server_port} {status} dest={h.get('Sec-Fetch-Dest', '-')} "
                  f"site={h.get('Sec-Fetch-Site', '-')} origin={h.get('Origin', '-')} "
                  f"cookie={'session=ok' in (h.get('Cookie') or '')} "
                  f"referer={h.get('Referer', '-')} {self.path}\n")

    def do_GET(self):
        parsed = urlsplit(self.path)
        path = parsed.path
        if path.startswith('/delayed/'):
            # Let the extension finish before the page, deterministically.
            # Optional extension delay exercises stale in-flight responses.
            params = parse_qs(parsed.query)
            if params.get('deny_ext') and self.headers.get('Sec-Fetch-Dest') != 'image':
                self._log(403)
                return self.send_error(403, 'test hotlink protection')
            delay = 1500 if self.headers.get('Sec-Fetch-Dest') == 'image' else int(params.get('ext_ms', ['0'])[0])
            self._log(200)
            time.sleep(min(max(delay, 0), 3000) / 1000)
            self.path = '/img/' + path[len('/delayed/'):]
            return super().do_GET()
        if path.startswith("/private/"):
            if "session=ok" not in (self.headers.get("Cookie") or ""):
                self._log(403)
                return self.send_error(403, "needs session cookie")
            self.path = "/img/" + path[len("/private/"):]
        elif path.startswith("/hotlink/"):
            if not (self.headers.get("Referer") or "").startswith("http://localhost:8000/"):
                self._log(403)
                return self.send_error(403, "hotlink protection")
            self.path = "/img/" + path[len("/hotlink/"):]
        self._log(200)
        return super().do_GET()


def serve(host, port, directory):
    httpd = http.server.ThreadingHTTPServer((host, port), partial(Handler, directory=directory))
    print(f"serving {directory} on http://{host}:{port}/", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    threading.Thread(target=serve, args=("127.0.0.1", 8001, os.path.join(SITE, "other")), daemon=True).start()
    try:
        serve("localhost", 8000, SITE)
    except KeyboardInterrupt:
        sys.exit(0)
