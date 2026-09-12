"""Real CUDA/HTTP canary on synthetic inputs only; prints aggregate checks."""
import base64
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

from PIL import Image, ImageDraw
from contract import MODEL, REVISION, RECIPE, validate_result


def main():
    token = secrets.token_hex(24)
    secret = Path('/tmp/smoke-token'); secret.write_text(token); secret.chmod(0o600)
    env = {**os.environ, 'TOKEN_FILE':str(secret), 'GPU_LOCK_FILE':'/tmp/smoke-gpu.lock'}
    diagnostics = Path('/tmp/smoke-server.log').open('w+')
    # Print only exception class, fixed local error codes and code locations.
    # Never print request bodies, model output or arbitrary exception strings.
    entry = '''
import json, traceback
import server
original = server.CatalogModel.catalog
def diagnosed(self, payload):
    try: return original(self, payload)
    except Exception as error:
        known = ['input_token_limit', 'truncated_result', 'invalid_result', 'model_revision_mismatch', 'incompatible_checkpoint', 'cuda_required']
        print(json.dumps({'diagnostic': True, 'type': type(error).__name__, 'code': str(error) if str(error) in known else 'library_error',
            'locations': [frame.filename.rsplit('/', 1)[-1]+':'+str(frame.lineno) for frame in traceback.extract_tb(error.__traceback__)]}), flush=True)
        raise
server.CatalogModel.catalog = diagnosed
server.main()
'''
    child = subprocess.Popen([sys.executable, '-c', entry], cwd='/app', env=env, stdout=diagnostics, stderr=diagnostics)
    try:
        for _ in range(50):
            if child.poll() is not None: raise RuntimeError('server_exit')
            try:
                urllib.request.urlopen('http://127.0.0.1:8092/health',timeout=1).close()
                break
            except OSError: time.sleep(0.2)
        else: raise RuntimeError('health_timeout')
        try:
            urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8092/catalog', data=b'{}'),timeout=2)
            raise RuntimeError('authentication_missing')
        except urllib.error.HTTPError as error:
            assert error.code == 401
        im = Image.new('RGB',(256,256),'white')
        ImageDraw.Draw(im).ellipse((40,40,216,216),fill='red')
        buffer = io.BytesIO(); im.save(buffer,format='JPEG'); im.close()
        for kind in ['image','text']:
            images = [base64.b64encode(buffer.getvalue()).decode()] if kind == 'image' else []
            payload = {'images':images,'media':{'kind':kind,'coverage':'saved_image' if images else 'archived_text','asset_count':len(images),'sampled_images':len(images)},
                       'source':{'title':'','caption':'' if images else 'Заметка о выборе шрифта и межстрочного интервала для книжного макета.','author':''}}
            started = time.monotonic()
            req = urllib.request.Request('http://127.0.0.1:8092/catalog', data=json.dumps(payload).encode(),
                headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
            with urllib.request.urlopen(req, timeout=480) as reply:
                value = json.loads(reply.read(32768))
            assert value['model'] == MODEL and value['revision'] == REVISION and value['recipe'] == RECIPE
            validate_result(value['result'])
            print(json.dumps({'kind':kind,'status':'success','seconds':round(time.monotonic()-started,2),'schema':True,'pinnedModel':True}),flush=True)
        print(json.dumps({'authenticated':True,'syntheticOnly':True,'newCloudRequests':0}),flush=True)
    finally:
        child.terminate()
        try: child.wait(timeout=10)
        except subprocess.TimeoutExpired: child.kill(); child.wait()
        diagnostics.seek(0)
        for line in diagnostics:
            if line.startswith('{"diagnostic":'):
                print(line.strip(), flush=True)
        diagnostics.close()
        secret.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
