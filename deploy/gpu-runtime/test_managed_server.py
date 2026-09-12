import concurrent.futures
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

from managed_server import ManagedServer

TOKEN = 'synthetic-private-token-for-tests'


def request(port, path='/catalog', body=None, token=TOKEN):
    req = urllib.request.Request('http://127.0.0.1:%d%s' % (port, path),
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


class ManagedRuntimeTests(unittest.TestCase):
    def server(self, invoke):
        server = ManagedServer(('127.0.0.1', 0), TOKEN, 'qwen', invoke, lambda body: body, 5)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 3)
        self.addCleanup(server.shutdown)
        return server, server.server_address[1]

    def test_health_responds_during_inference_and_second_call_waits(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        def infer(value):
            calls.append(value)
            entered.set()
            release.wait(3)
            return {'result': 'synthetic'}

        server, port = self.server(infer)
        with concurrent.futures.ThreadPoolExecutor() as pool:
            first = pool.submit(request, port, body={'synthetic': 1})
            self.assertTrue(entered.wait(2))
            try:
                self.assertEqual(request(port, '/health')[0], 200)
                self.assertEqual(request(port, body={'synthetic': 2})[0], 429)
            finally:
                release.set()
            self.assertEqual(first.result()[0], 200)
        self.assertEqual(calls, [{'synthetic': 1}])
        self.assertEqual(request(port, body={'synthetic': 3})[0], 200)
        self.assertFalse(server.draining.is_set())

    def test_bad_auth_and_wrong_route_do_not_invoke_model(self):
        calls = []
        _, port = self.server(lambda value: calls.append(value))
        self.assertEqual(request(port, body={}, token='wrong')[0], 401)
        self.assertEqual(request(port, '/arbitrary', {})[0], 400)
        self.assertFalse(calls)

    def test_model_failure_retires_process_without_echoing_exception(self):
        def fail(_):
            raise RuntimeError('private model output')
        server, port = self.server(fail)
        self.assertEqual(request(port, body={}), (503, {'error': 'local_unavailable'}))
        self.assertTrue(server.draining.is_set())

    def test_qwen_warm_load_does_not_import_model_libraries_again(self):
        directory = Path(__file__).resolve().parents[1] / 'local-catalog'
        sys.path.insert(0, str(directory))
        self.addCleanup(sys.path.remove, str(directory))
        spec = importlib.util.spec_from_file_location('qwen_warm_model', directory / 'model.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        model = module.CatalogModel()
        model.model, model.processor, model.tokenizer_data = object(), object(), object()
        # No Torch/Transformers installed in this test runtime. Warm load must return
        # before importing either; the actual guarded CatalogModel.load is called.
        original = (model.model, model.processor, model.tokenizer_data)
        model.load()
        model.load()
        self.assertEqual((model.model, model.processor, model.tokenizer_data), original)

    def process_case(self, watchdog=False):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'token').write_text(TOKEN)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            # Only this test injects a CPU callback. The production CLI has no fake
            # mode, deadline override, arbitrary script path or user-supplied command.
            script = "import managed_server as m, time; m.backend=lambda kind: (lambda p: (time.sleep(5) or {}), lambda p:p, .2); m.main()" if watchdog else \
                     "import managed_server as m; m.backend=lambda kind: (lambda p: {}, lambda p:p, 5); m.main()"
            process = subprocess.Popen([sys.executable, '-c', script, '--kind', 'qwen', '--port', str(port)],
                cwd=Path(__file__).parent, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                env={'PATH': os.defpath, 'PYTHONDONTWRITEBYTECODE': '1',
                     'TOKEN_FILE': str(root / 'token'), 'GPU_LOCK_FILE': str(root / 'gpu.lock')})
            try:
                until = time.monotonic() + 4
                while True:
                    try:
                        if request(port, '/health')[0] == 200:
                            break
                    except OSError:
                        if time.monotonic() >= until:
                            raise
                        time.sleep(.03)
                with (root / 'gpu.lock').open('a') as handle:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.assertEqual(request(port, body={}), (429, {'error': 'resource_busy'}))
                    self.assertEqual(request(port, '/health')[0], 200)
                if watchdog:
                    with self.assertRaises((OSError, __import__('http.client').client.RemoteDisconnected)):
                        request(port, body={})
                    self.assertEqual(process.wait(3), -signal.SIGKILL)
                else:
                    self.assertEqual(request(port, body={})[0], 200)
                    self.assertEqual(request(port, body={})[0], 200)
                    with (root / 'gpu.lock').open('a') as handle:
                        with self.assertRaises(BlockingIOError):
                            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    process.terminate()
                    self.assertEqual(process.wait(3), 0)
                with (root / 'gpu.lock').open('a') as handle:
                    fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait(3)

    def test_real_process_retains_lease_across_calls_and_releases_on_exit(self):
        self.process_case()

    def test_hard_deadline_kills_process_and_releases_lease(self):
        self.process_case(watchdog=True)


if __name__ == '__main__':
    unittest.main()
