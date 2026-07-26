#!/usr/bin/env python3
"""Serve the browser click-CAPTCHA fixture with module and WASM MIME types."""

from __future__ import annotations

import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class FixtureRequestHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.mjs': 'text/javascript',
        '.wasm': 'application/wasm',
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=4173)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    handler = lambda *handler_args, **handler_kwargs: FixtureRequestHandler(
        *handler_args,
        directory=str(root),
        **handler_kwargs,
    )
    server = ThreadingHTTPServer(('127.0.0.1', args.port), handler)
    print(f'Fixture server: http://127.0.0.1:{args.port}/tests/click-captcha-worker.html')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
