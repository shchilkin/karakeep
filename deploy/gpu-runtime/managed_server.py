"""Native HTTP entrypoint for one model process owned by llama-swap.

The kernel lease lasts until process exit. This module never starts/stops other
models: llama-swap owns that lifecycle. Model libraries are imported lazily.
"""
import argparse
import hmac
import importlib.util
import json
import os
from pathlib import Path
import signal
from socketserver import ThreadingMixIn
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                  HF_HUB_DISABLE_TELEMETRY='1', TOKENIZERS_PARALLELISM='false')


class ManagedServer(ThreadingMixIn, HTTPServer):
    request_queue_size = 4
    daemon_threads = False

    def __init__(self, address, token, kind, invoke, validate, deadline, terminate=None, admit=None):
        self.token, self.kind = token, kind
        self.invoke, self.validate, self.deadline = invoke, validate, deadline
        self.terminate = terminate or (lambda: os.kill(os.getpid(), signal.SIGKILL))
        self.admit = admit or (lambda: True)
        self.executing = threading.Lock()
        self.connections = threading.BoundedSemaphore(4)
        self.draining = threading.Event()
        super().__init__(address, Handler)

    def handle_error(self, *_):
        pass  # No private payloads, exception text or model output in logs.

    def process_request(self, request, address):
        if not self.connections.acquire(blocking=False):
            try:
                request.settimeout(1)
                request.sendall(b'HTTP/1.1 429 Too Many Requests\r\nContent-Length: 0\r\n'
                                b'Retry-After: 30\r\nConnection: close\r\n\r\n')
            except OSError:
                pass
            finally:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.connections.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.connections.release()

    def drain(self):
        if not self.draining.is_set():
            self.draining.set()
            threading.Thread(target=self.shutdown, daemon=True).start()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def reply(self, status, value):
        self.close_connection = True
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        if status == 429:
            self.send_header('Retry-After', '30')
        self.end_headers()
        try:
            self.wfile.write(data)
        except OSError:
            pass

    def do_GET(self):
        status = 404 if self.path != '/health' else 503 if self.server.draining.is_set() else 200
        self.reply(status, {'status': 'ok' if status == 200 else 'unavailable'})

    def do_POST(self):
        if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + self.server.token):
            self.reply(401, {'error': 'unauthorized'})
            return
        if self.server.draining.is_set():
            self.reply(503, {'error': 'local_unavailable'})
            return
        route = '/classify' if self.server.kind == 'shield' else '/catalog'
        if self.path != route or self.headers.get('Transfer-Encoding'):
            self.reply(400, {'error': 'invalid_request'})
            return
        if not self.server.executing.acquire(blocking=False):
            self.reply(429, {'error': 'resource_busy'})
            return
        watchdog = None
        try:
            maximum = (3 if self.server.kind == 'shield' else 9) * 1024 * 1024
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= maximum:
                raise ValueError('body_limit')
            payload = self.server.validate(json.loads(self.rfile.read(size)))
            # A definitive refusal before model execution is safe to defer in the
            # durable queue. Readiness alone does not promise GPU availability.
            if not self.server.admit():
                self.reply(429, {'error': 'resource_busy'})
                return
            # Independent wall deadline covers cold load and inference in this thread.
            watchdog = threading.Timer(self.server.deadline, self.server.terminate)
            watchdog.daemon = True
            watchdog.start()
            result = self.server.invoke(payload)
            self.reply(200, result)
        except (ValueError, TypeError):
            self.reply(400, {'error': 'invalid_request'})
        except Exception:
            # Poisoned CUDA/model state is retired as a whole process. The process
            # retains its lease while response cleanup and shutdown are in progress.
            self.server.drain()
            self.reply(503, {'error': 'local_unavailable'})
        finally:
            if watchdog:
                watchdog.cancel()
            self.server.executing.release()


def backend(kind):
    deploy = Path(__file__).resolve().parents[1]
    directory = deploy / ('sensitive-classifier' if kind == 'shield' else 'local-catalog')
    sys.path.insert(0, str(directory))
    if kind == 'shield':
        spec = importlib.util.spec_from_file_location('native_classifier', directory / 'server.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        model = module.Classifier()

        def validate(value):
            if not isinstance(value, dict) or set(value) != {'image'}:
                raise ValueError('invalid_request')
            return value

        return lambda payload: model.classify(payload['image']), validate, 110
    from model import CatalogModel
    from contract import validate_request
    return CatalogModel().catalog, validate_request, 465


class ResidentLease:
    def __init__(self, path):
        self.path, self.handle = path, None

    def admit(self):
        if self.handle is not None:
            return True
        from gpu_lease import acquire
        try:
            self.handle = acquire(self.path, seconds=0)
            return True
        except TimeoutError:
            return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--kind', choices=['shield', 'qwen'], required=True)
    parser.add_argument('--port', type=int, required=True)
    args = parser.parse_args()
    token = Path(os.environ['TOKEN_FILE']).read_text().strip()
    if len(token) < 24 or not token.isascii():
        raise ValueError('private_token_required')
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sensitive-classifier'))
    # Acquire before the first model call, then retain ownership until process
    # exit. A waiting child can answer 429 instead of failing proxy startup.
    lease = ResidentLease(os.environ['GPU_LOCK_FILE'])
    invoke, validate, deadline = backend(args.kind)
    server = ManagedServer(('127.0.0.1', args.port), token, args.kind, invoke, validate, deadline, admit=lease.admit)
    signal.signal(signal.SIGTERM, lambda *_: server.drain())
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()  # Wait for request threads before process termination.
        # Never close the lease while a CUDA context may remain. Kernel closes it
        # on process exit, including SIGKILL. No per-call model unload is needed.
        os._exit(0)


if __name__ == '__main__':
    main()
