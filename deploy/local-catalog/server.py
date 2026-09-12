"""Private sequential catalog endpoint. No archive mounts, downloads or raw logs."""
import hmac
import json
import os
import signal
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                  HF_HUB_DISABLE_TELEMETRY='1', TOKENIZERS_PARALLELISM='false')
from contract import validate_request
from gpu_lease import configured_lease
from model import CatalogModel


class Server(HTTPServer):
    request_queue_size = 2

    def handle_error(self, *_):
        pass


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def send_json(self, status, value):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.send_json(200 if self.path == '/health' else 404,
                       {'status': 'ok' if self.path == '/health' else 'not_found'})

    def do_POST(self):
        self.close_connection = True
        if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + self.server.token):
            self.send_json(401, {'error': 'unauthorized'})
            return
        lease = None
        status, result = 503, {'error': 'local_unavailable'}
        try:
            if self.path != '/catalog' or self.headers.get('Transfer-Encoding'):
                raise ValueError('invalid_request')
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 9 * 1024 * 1024:
                raise ValueError('body_limit')
            payload = validate_request(json.loads(self.rfile.read(size)))
            # Includes the lease, cold load, constrained generation and cleanup.
            # Default SIGALRM terminates a wedged CUDA process; Docker restarts it.
            signal.alarm(465)
            lease = configured_lease(required=True)
            result = self.server.model.catalog(payload)
            status = 200
        except (ValueError, TypeError):
            status, result = 400, {'error': 'invalid_request'}
        except Exception:
            pass  # No exception text, prompts or answers in logs.
        # Leave the exception scope before unloading: its traceback may own tensors.
        if lease:
            self.server.model.unload()
            lease.close()
        signal.alarm(0)
        self.send_json(status, result)


def main():
    token = Path(os.environ.get('TOKEN_FILE', '/run/secrets/local_token')).read_text().strip()
    if len(token) < 24 or not token.isascii() or not os.environ.get('GPU_LOCK_FILE'):
        raise ValueError('private_service_configuration_required')
    server = Server(('0.0.0.0', 8092), Handler)
    server.token, server.model = token, CatalogModel()
    server.serve_forever()


if __name__ == '__main__':
    main()
