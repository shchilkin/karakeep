"""Private, sequential GPU classifier. No archive mounts, outbound calls or raw logs."""
import base64
import gc
import hashlib
import hmac
import io
import json
import os
import signal
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from shieldgemma import MODEL, REVISION, POLICIES, POLICIES_SHA256, response, repair_output_head
from gpu_lease import configured_lease
MAX_BODY = 3 * 1024 * 1024
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                  HF_HUB_DISABLE_TELEMETRY='1', TOKENIZERS_PARALLELISM='false')


class Classifier:
    def __init__(self):
        self.model = self.processor = None
        self.last_used = time.monotonic()

    def load(self):
        if self.model is not None:
            return
        import torch
        from transformers import AutoProcessor, ShieldGemma2ForImageClassification
        directory = Path(os.environ.get('MODEL_DIR', '/models'))
        manifest = json.loads((directory / 'download-manifest.json').read_text())
        if manifest['model'] != MODEL or manifest['revision'] != REVISION:
            raise RuntimeError('model_revision_mismatch')
        if not torch.cuda.is_available():
            raise RuntimeError('cuda_required')
        torch.set_num_threads(2)
        processor = AutoProcessor.from_pretrained(directory, local_files_only=True, trust_remote_code=False, use_fast=False)
        digest = hashlib.sha256(json.dumps(processor.policy_definitions, sort_keys=True).encode()).hexdigest()
        if set(processor.policy_definitions) != set(POLICIES) or digest != POLICIES_SHA256:
            raise RuntimeError('native_policy_mismatch')
        # The outer wrapper rejects SDPA; its Gemma3 text/vision backbone supports it.
        model, loading_info = ShieldGemma2ForImageClassification.from_pretrained(
            directory, local_files_only=True, trust_remote_code=False,
            dtype=torch.bfloat16, device_map={'': 0}, attn_implementation='eager',
            low_cpu_mem_usage=True, output_loading_info=True)
        repair_output_head(model, loading_info)
        model.model.set_attn_implementation('sdpa')
        if any(c._attn_implementation != 'sdpa' for c in [model.model.config.text_config, model.model.config.vision_config]):
            raise RuntimeError('backbone_sdpa_required')
        self.model, self.processor = model.eval(), processor

    def unload(self):
        self.model = self.processor = None
        gc.collect()
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def classify(self, encoded):
        from PIL import Image
        if not isinstance(encoded, str) or len(encoded) > 2800000:
            raise ValueError('image_limit')
        pixels = base64.b64decode(encoded, validate=True)
        if not pixels or len(pixels) > 2 * 1024 * 1024:
            raise ValueError('image_limit')
        with Image.open(io.BytesIO(pixels)) as original:
            if original.format != 'JPEG' or max(original.size) > 768:
                raise ValueError('expected_prepared_jpeg')
            image = original.convert('RGB')
        import torch
        try:
            self.load()
            scores = {}
            for policy in POLICIES:
                # One image/policy per pass bounds VRAM; no generation or KV cache.
                inputs = self.processor(images=[image], policies=[policy], return_tensors='pt').to('cuda')
                if inputs['input_ids'].shape[-1] > 4096:
                    raise ValueError('input_token_limit')
                inputs['pixel_values'] = inputs['pixel_values'].to(torch.bfloat16)
                with torch.inference_mode():
                    # forward() orders [Yes, No]; index zero is policy violation.
                    scores[policy] = float(self.model(**inputs, logits_to_keep=1, use_cache=False).probabilities[0, 0].cpu())
                del inputs
            return response(scores)
        finally:
            self.last_used = time.monotonic()
            image.close()


class Server(HTTPServer):
    # One model invocation at a time, bounded TCP backlog and body read deadline.
    request_queue_size = 2

    def handle_error(self, *_):
        pass  # A disconnected client must not print request/traceback data.

    def service_actions(self):
        classifier = self.classifier
        if classifier.model is not None and time.monotonic() - classifier.last_used > 120:
            classifier.unload()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def send_json(self, status, payload):
        body = json.dumps(payload).encode()
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
        expected = 'Bearer ' + self.server.token
        if not hmac.compare_digest(self.headers.get('Authorization', ''), expected):
            self.close_connection = True
            self.send_json(401, {'error': 'unauthorized'})
            return
        status = 200
        unload = False
        lease = None
        try:
            if self.path != '/classify' or self.headers.get('Transfer-Encoding'):
                raise ValueError('invalid_request')
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= MAX_BODY:
                raise ValueError('body_limit')
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict) or set(payload) != {'image'}:
                raise ValueError('invalid_request')
            # Hard upper bound includes loading. A wedged CUDA process is killed;
            # the app retains a retryable local failure, never dispatches cloud.
            signal.alarm(110)
            lease = configured_lease()
            result = self.server.classifier.classify(payload['image'])
        except (ValueError, TypeError):
            status, result = 400, {'error': 'invalid_request'}
        except Exception:
            status, result = 503, {'error': 'local_unavailable'}
            unload = True
        finally:
            self.close_connection = True
        # Tracebacks can retain model/input tensors until the exception scope ends.
        # Release them before flushing CUDA and before a disconnected client writes.
        # Hybrid mode gives up residency after each request, including failures.
        # The lease is held until CUDA cache and model tensors are released.
        if unload or lease:
            self.server.classifier.unload()
        if lease:
            lease.close()
        signal.alarm(0)
        self.send_json(status, result)


def main():
    token = Path(os.environ.get('TOKEN_FILE', '/run/secrets/local_token')).read_text().strip()
    if len(token) < 24:
        raise ValueError('token_required')
    server = Server(('0.0.0.0', 8091), Handler)
    server.token = token
    server.classifier = Classifier()
    server.serve_forever(poll_interval=1)


if __name__ == '__main__':
    main()
