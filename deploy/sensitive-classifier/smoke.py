"""Run inside an isolated GPU container. Synthetic images only; no cloud or DB."""
import base64
import io
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from PIL import Image, ImageDraw
from shieldgemma import MODEL, REVISION, POLICY_VERSION, POLICIES

token = secrets.token_hex(24)
token_path = Path('/tmp/local-token')
token_path.write_text(token)
token_path.chmod(0o600)
env = dict(os.environ, TOKEN_FILE=str(token_path))
process = subprocess.Popen([sys.executable, '/app/server.py'], env=env)
try:
    for _ in range(100):
        if process.poll() is not None:
            raise RuntimeError('server_exited')
        try:
            urllib.request.urlopen('http://127.0.0.1:8091/health', timeout=1).close()
            break
        except OSError:
            time.sleep(.1)
    results = []
    for kind in ['gray', 'geometry']:
        image = Image.new('RGB', (384, 384), '#aaaaaa')
        if kind == 'geometry':
            draw = ImageDraw.Draw(image)
            draw.rectangle((30, 30, 170, 150), fill='blue')
            draw.ellipse((190, 190, 330, 330), fill='orange')
        buffer = io.BytesIO()
        image.save(buffer, format='JPEG')
        body = json.dumps({'image': base64.b64encode(buffer.getvalue()).decode()}).encode()
        request = urllib.request.Request('http://127.0.0.1:8091/classify', data=body,
                                        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        started = time.monotonic()
        with urllib.request.urlopen(request, timeout=120) as response:
            result = json.load(response)
        assert result['status'] == 'complete' and result['categories'] == [], result
        assert (result['model'], result['revision'], result['policy']) == (MODEL, REVISION, POLICY_VERSION)
        assert set(result['scores']) == set(POLICIES) and all(0 <= v < 0.5 for v in result['scores'].values())
        results.append({'fixture': kind, 'seconds': round(time.monotonic() - started, 3), **result})
    try:
        urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8091/classify', data=b'{}'), timeout=5)
        raise AssertionError('authentication_not_enforced')
    except urllib.error.HTTPError as error:
        assert error.code == 401
    print(json.dumps({'gpu_http_smoke': 'passed', 'results': results}), flush=True)
finally:
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    token_path.unlink(missing_ok=True)
