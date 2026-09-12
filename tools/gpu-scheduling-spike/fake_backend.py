#!/usr/bin/env python3
"""CPU-only transport/lifecycle fixture. Never imports Torch or loads model weights."""
import argparse
import base64
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--name', choices=['shield', 'qwen'], required=True)
    parser.add_argument('--events', type=Path, required=True)
    parser.add_argument('--lock', type=Path, required=True)
    parser.add_argument('--ignore-term', action='store_true')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    shield = load_module('shield_contract', repo / 'deploy/sensitive-classifier/shieldgemma.py')
    catalog = load_module('catalog_contract', repo / 'deploy/local-catalog/contract.py')

    def event(kind, **fields):
        # No request bodies, descriptions, headers or media are logged.
        row = dict(kind=kind, name=args.name, pid=os.getpid(), at=time.monotonic(), **fields)
        with args.events.open('a') as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            f.write(json.dumps(row) + '\n')
            f.flush()

    lock = args.lock.open('a')
    event('process_started')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        event('lock_conflict')
        return 23
    event('model_loaded')  # Simulated residency, but a REAL process-held kernel FLOCK.
    draining = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, value):
            data = json.dumps(value).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                event('client_disconnected')

        def do_GET(self):
            self.reply(200 if self.path == '/health' else 404, {'status': 'ok'})

        def do_POST(self):
            if self.headers.get('Authorization') != 'Bearer fake-private-token':
                self.reply(401, {'error': 'unauthorized'})
                return
            if draining.is_set():
                self.reply(503, {'error': 'resource_busy'})
                return
            expected = '/classify' if args.name == 'shield' else '/catalog'
            if self.path != expected:
                self.reply(404, {'error': 'not_found'})
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 9 * 1024 * 1024:
                    raise ValueError()
                body = json.loads(self.rfile.read(size))
                if args.name == 'shield':
                    if set(body) != {'image'} or not base64.b64decode(body['image'], validate=True):
                        raise ValueError()
                else:
                    catalog.validate_request(body)
            except (ValueError, TypeError, KeyError):
                self.reply(400, {'error': 'invalid_request'})
                return
            event('execution_started', operation=self.headers.get('X-Spike-Operation', 'none'))
            if self.headers.get('X-Spike-Crash') == 'true':
                event('injected_crash')
                os._exit(17)
            # Test controls are never accepted by real production endpoints.
            delay = min(4, max(0, float(self.headers.get('X-Spike-Delay', '0'))))
            time.sleep(delay)
            if args.name == 'shield':
                result = shield.response({'dangerous': 0.1, 'sexual': 0.1, 'violence': 0.1})
            else:
                result = dict(model=catalog.MODEL, revision=catalog.REVISION, recipe=catalog.RECIPE,
                              result=catalog.validate_result({'title': 'Synthetic fixture',
                                  'summary': 'CPU-only contract test', 'tags': ['synthetic']}))
            event('execution_finished')
            self.reply(200, result)

    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.timeout = 1

    def terminate(*_):
        event('sigterm_received')
        if args.ignore_term or draining.is_set():
            return
        draining.set()

        def drain():
            time.sleep(0.3)  # Make process-exit ordering observable.
            server.shutdown()

        threading.Thread(target=drain).start()

    signal.signal(signal.SIGTERM, terminate)
    try:
        server.serve_forever(poll_interval=0.05)
    finally:
        server.server_close()  # Wait for active request threads before releasing ownership.
        event('process_exiting')
        lock.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
