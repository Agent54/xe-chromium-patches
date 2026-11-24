#!/usr/bin/env python3
"""Static server for the repro IWA (dev-mode proxy) and the guest pages.

Port A serves results/repro/iwa (the IWA, installed with
--install-isolated-web-app-from-url). Port B serves results/repro/guest_site
and collects beacons from guest pages: POST /beacon, GET /beacons, POST /reset.
"""
import json, os, sys, threading, time
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ROOT = os.path.dirname(os.path.abspath(__file__))
BEACONS = []
LOCK = threading.Lock()

def handler(directory):
  class H(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      '.webmanifest': 'application/manifest+json',
                      '.js': 'text/javascript', '.html': 'text/html',
                      '.css': 'text/css', '.png': 'image/png'}
    def __init__(self, *a, **k):
      super().__init__(*a, directory=directory, **k)
    def log_message(self, *a):
      pass
    def end_headers(self):
      self.send_header('Cache-Control', 'no-store')
      super().end_headers()
    def _json(self, obj):
      data = json.dumps(obj).encode()
      self.send_response(200)
      self.send_header('Content-Type', 'application/json')
      self.send_header('Content-Length', str(len(data)))
      self.end_headers()
      self.wfile.write(data)
    def do_GET(self):
      if self.path.startswith('/beacons'):
        with LOCK:
          return self._json(BEACONS)
      return super().do_GET()
    def do_POST(self):
      n = int(self.headers.get('Content-Length', 0))
      body = self.rfile.read(n)
      if self.path == '/beacon':
        try:
          b = json.loads(body)
        except Exception:
          b = {'raw': body.decode(errors='replace')}
        b['srv_t'] = time.time()
        with LOCK:
          BEACONS.append(b)
        return self._json({})
      if self.path == '/reset':
        with LOCK:
          BEACONS.clear()
        return self._json({})
      self.send_response(404)
      self.end_headers()
  return H

def main():
  pa, pb = int(sys.argv[1]), int(sys.argv[2])
  sa = ThreadingHTTPServer(('127.0.0.1', pa), handler(os.path.join(ROOT, 'iwa')))
  sb = ThreadingHTTPServer(('127.0.0.1', pb), handler(os.path.join(ROOT, 'guest_site')))
  threading.Thread(target=sa.serve_forever, daemon=True).start()
  print('serving', pa, pb, flush=True)
  sb.serve_forever()

if __name__ == '__main__':
  main()
