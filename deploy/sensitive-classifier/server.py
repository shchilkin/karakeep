"""Private, sequential GPU classifier. No archive mounts, outbound calls or raw logs."""
import base64
import gc
import hmac
import io
import json
import os
import signal
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from policy import POLICY, parse_result

MODEL = 'nvidia/Nemotron-3.5-Content-Safety'
REVISION = '35645ed3543b7e7ffaed2e788699e57a5051497c'
POLICY_VERSION = 'nemotron-visibility-v3'
MAX_BODY = 3 * 1024 * 1024
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                  HF_HUB_DISABLE_TELEMETRY='1', TOKENIZERS_PARALLELISM='false')


def response(status, categories):
    return dict(model=MODEL, revision=REVISION, policy=POLICY_VERSION,
                precision='bf16', status=status, categories=categories)


class Classifier:
    def __init__(self):
        self.model = self.processor = None
        self.last_used = time.monotonic()

    def load(self):
        if self.model is not None:
            return
        import torch
        from transformers import AutoProcessor, Gemma3ForConditionalGeneration
        directory = Path(os.environ.get('MODEL_DIR', '/models'))
        manifest = json.loads((directory / 'download-manifest.json').read_text())
        if manifest['model'] != MODEL or manifest['revision'] != REVISION:
            raise ValueError('model_revision_mismatch')
        if not torch.cuda.is_available():
            raise RuntimeError('cuda_required')
        torch.set_num_threads(2)
        self.processor = AutoProcessor.from_pretrained(directory, local_files_only=True, trust_remote_code=False)
        self.model = Gemma3ForConditionalGeneration.from_pretrained(
            directory, local_files_only=True, trust_remote_code=False,
            dtype=torch.bfloat16, device_map={'': 0}, attn_implementation='sdpa',
            low_cpu_mem_usage=True).eval()

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
        self.load()
        try:
            content = [{'type': 'image', 'image': image},
                       {'type': 'text', 'text': 'Classify the sensitivity categories visible in this attached image.'}]
            prompt = self.processor.apply_chat_template(
                [{'role': 'user', 'content': content}], tokenize=False,
                add_generation_prompt=True, request_categories='/categories',
                custom_policy=POLICY, enable_thinking=False)
            inputs = self.processor(text=prompt, images=[image], return_tensors='pt',
                                    add_special_tokens=False).to('cuda')
            if inputs['input_ids'].shape[-1] > 4096:
                raise ValueError('input_token_limit')
            if 'pixel_values' in inputs:
                inputs['pixel_values'] = inputs['pixel_values'].to(torch.bfloat16)
            with torch.inference_mode():
                generated = self.model.generate(**inputs, max_new_tokens=160, max_time=60, do_sample=False)
            tokens = generated[0, inputs['input_ids'].shape[-1]:]
            eos = self.model.generation_config.eos_token_id
            eos_set = set(eos if isinstance(eos, list) else [eos])
            truncated = not len(tokens) or int(tokens[-1]) not in eos_set
            text = self.processor.decode(tokens, skip_special_tokens=True).strip()
            parsed = parse_result(text, truncated)
            return response(parsed['status'], parsed['categories'])
        finally:
            self.last_used = time.monotonic()
            image.close()


class Server(HTTPServer):
    # One model invocation at a time, bounded TCP backlog and body read deadline.
    request_queue_size = 2

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
            result = self.server.classifier.classify(payload['image'])
            signal.alarm(0)
            self.send_json(200, result)
        except (ValueError, TypeError):
            signal.alarm(0)
            self.send_json(400, {'error': 'invalid_request'})
        except Exception:
            signal.alarm(0)
            self.send_json(503, {'error': 'local_unavailable'})
            self.server.classifier.unload()
        finally:
            self.close_connection = True


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
