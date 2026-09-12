#!/usr/bin/env python3
"""Exercise a pinned real llama-swap against private, fake CPU model services."""
import argparse
import concurrent.futures
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request


def free_ports(count):
    sockets = []
    try:
        for _ in range(count):
            sock = socket.socket()
            sockets.append(sock)
            sock.bind(('127.0.0.1', 0))
        return [sock.getsockname()[1] for sock in sockets]
    finally:
        for sock in sockets:
            sock.close()


def wait_for(check, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError('Timed out waiting for fixture evidence')


def dead(pid):
    result = subprocess.run(['ps', '-o', 'stat=', '-p', str(pid)], capture_output=True, text=True)
    return result.returncode != 0 or not result.stdout.strip() or result.stdout.strip().startswith('Z')


class Fixture:
    def __init__(self, binary, *, ttl=0, ignore_term=False):
        self.tmp = tempfile.TemporaryDirectory(prefix='karakeep-gpu-spike-')
        self.root = Path(self.tmp.name)
        self.events_file = self.root / 'events.jsonl'
        self.lock_file = self.root / 'gpu.lock'
        self.port, shield_port, qwen_port = free_ports(3)
        self.binary = binary
        self.processes = []
        self.logs = []
        fake = Path(__file__).with_name('fake_backend.py')
        models = {}
        for name, backend_port in [('shield', shield_port), ('qwen', qwen_port)]:
            command = ' '.join(map(shlex.quote, [sys.executable, str(fake), '--name', name,
                                  '--events', str(self.events_file), '--lock', str(self.lock_file),
                                  '--port', str(backend_port)]))
            if ignore_term:
                command += ' --ignore-term'
            models[name] = {'cmd': command, 'proxy': 'http://127.0.0.1:%d' % backend_port,
                            'checkEndpoint': '/health', 'ttl': ttl,
                            'unloadTimeout': 1, 'concurrencyLimit': 1}
        config = {'healthCheckTimeout': 15, 'logLevel': 'error', 'models': models,
                  'captureBuffer': 0, 'performance': {'disabled': True},
                  'routing': {'router': {'use': 'group', 'settings': {
                      'groups': {'heavy': {'swap': True, 'exclusive': True, 'members': ['shield', 'qwen']}}
                  }}}}
        # JSON is a YAML subset; avoid adding PyYAML or other test dependencies.
        self.config = self.root / 'config.yaml'
        self.config.write_text(json.dumps(config))
        try:
            self.start()
        except BaseException:
            self.close()
            raise

    def start(self):
        log = (self.root / ('proxy-%d.log' % len(self.processes))).open('wb')
        self.logs.append(log)
        process = subprocess.Popen([str(self.binary), '-config', str(self.config),
                                    '-listen', '127.0.0.1:%d' % self.port],
                                   stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                                   env={'PATH': os.defpath, 'PYTHONDONTWRITEBYTECODE': '1'})
        self.processes.append(process)
        self.proxy = process
        wait_for(lambda: self.request('/health')[0] == 200)

    def request(self, path, body=None, headers=None, timeout=12):
        hdr = {'Authorization': 'Bearer fake-private-token', 'Content-Type': 'application/json'}
        hdr.update(headers or {})
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request('http://127.0.0.1:%d%s' % (self.port, path), data=data, headers=hdr)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                code, raw = response.status, response.read()
        except urllib.error.HTTPError as error:
            code, raw = error.code, error.read()
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError):
            return 0, None
        try:
            return code, json.loads(raw)
        except ValueError:
            return code, raw.decode(errors='replace')

    def call(self, name, **headers):
        if name == 'shield':
            body = {'image': 'c3ludGhldGljLWJ5dGVz'}  # Transport only; no real JPEG decoder/inference.
            path = '/classify'
        else:
            body = {'media': {'kind': 'text', 'coverage': 'archived_text', 'asset_count': 0,
                              'sampled_images': 0},
                    'source': {'title': '', 'caption': 'Synthetic fixture', 'author': ''}, 'images': []}
            path = '/catalog'
        return self.request('/upstream/' + name + path, body, headers)

    def events(self, kind=None, name=None):
        if not self.events_file.exists():
            return []
        rows = []
        for line in self.events_file.read_text().splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if (kind is None or row['kind'] == kind) and (name is None or row['name'] == name):
                rows.append(row)
        return rows

    def lock_available(self):
        with self.lock_file.open('a') as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True
            except BlockingIOError:
                return False

    def close(self):
        # Signal only the exact proxy handles and fixture child PIDs we recorded.
        child_pids = {event['pid'] for event in self.events('process_started')}
        for process in reversed(self.processes):
            if process.poll() is None:
                process.terminate()
        for pid in child_pids:
            if not dead(pid):
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and any(not dead(e['pid']) for e in self.events('process_started')):
            time.sleep(0.05)
        for process in reversed(self.processes):
            if process.poll() is None:
                process.kill()
            process.wait(timeout=3)
        for pid in child_pids:
            if not dead(pid):
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                wait_for(lambda: dead(pid), timeout=3)
        for log in self.logs:
            log.close()
        self.tmp.cleanup()


class Compatibility(unittest.TestCase):
    binary = None
    evidence = {}

    def fixture(self, **kwargs):
        value = Fixture(self.binary, **kwargs)
        self.addCleanup(value.close)
        return value

    def test_custom_contracts_and_warm_reuse(self):
        f = self.fixture()
        for _ in range(3):
            status, body = f.call('shield')
            self.assertEqual(status, 200)
            self.assertEqual(body['policy'], 'shieldgemma-native-v1')
            self.assertEqual(body['status'], 'complete')
        self.assertEqual(len(f.events('model_loaded', 'shield')), 1)
        status, body = f.call('qwen')
        self.assertEqual(status, 200)
        self.assertEqual(body['recipe'], 'qwen35-nf4-catalog-v1')
        self.assertEqual(set(body['result']), {'title', 'summary', 'tags'})
        self.assertFalse(f.events('lock_conflict'))

    def test_auth_and_invalid_contract_passthrough(self):
        f = self.fixture()
        self.assertEqual(f.call('shield', Authorization='Bearer wrong')[0], 401)
        self.assertEqual(f.request('/upstream/qwen/catalog', {'invalid': True})[0], 400)
        self.assertFalse(f.events('execution_started'))

    def test_control_responsive_and_same_model_concurrency_bounded(self):
        f = self.fixture()
        with concurrent.futures.ThreadPoolExecutor() as pool:
            running = pool.submit(f.call, 'shield', **{'X-Spike-Delay': '1.5'})
            wait_for(lambda: f.events('execution_started'))
            start = time.monotonic()
            self.assertEqual(f.request('/running')[0], 200)
            latency = time.monotonic() - start
            self.assertLess(latency, 0.5)
            self.assertEqual(f.call('shield')[0], 429)
            self.assertEqual(running.result()[0], 200)
        self.evidence['controlLatencySeconds'] = round(latency, 4)

    def test_switch_drains_active_execution_and_releases_kernel_lock(self):
        f = self.fixture()
        with concurrent.futures.ThreadPoolExecutor() as pool:
            first = pool.submit(f.call, 'shield', **{'X-Spike-Delay': '1.2'})
            wait_for(lambda: f.events('execution_started', 'shield'))
            second = pool.submit(f.call, 'qwen')
            self.assertEqual(first.result()[0], 200)
            self.assertEqual(second.result()[0], 200)
        previous = f.events('model_loaded', 'shield')[0]
        wait_for(lambda: dead(previous['pid']))
        self.assertFalse(f.events('lock_conflict'))
        # The flock-serialized event log orders processes without comparing their
        # monotonic epochs (older macOS Python versions use different epochs).
        rows = f.events()
        loaded = rows.index(f.events('model_loaded', 'qwen')[0])
        self.assertLess(rows.index(f.events('execution_finished', 'shield')[0]), loaded)
        self.assertLess(rows.index(f.events('process_exiting', 'shield')[0]), loaded)

    def test_ttl_unloads_and_process_really_exits(self):
        f = self.fixture(ttl=1)
        self.assertEqual(f.call('shield')[0], 200)
        pid = f.events('model_loaded')[0]['pid']
        wait_for(lambda: dead(pid), timeout=8)
        self.assertTrue(f.lock_available())

    def test_forced_unload_of_unresponsive_process_releases_lock(self):
        f = self.fixture(ignore_term=True)
        self.assertEqual(f.call('shield')[0], 200)
        pid = f.events('model_loaded')[0]['pid']
        self.assertEqual(f.request('/api/models/unload/shield', {})[0], 200)
        wait_for(lambda: dead(pid), timeout=8)
        self.assertTrue(f.lock_available())

    def test_backend_crash_does_not_replay_http_request(self):
        f = self.fixture()
        status, _ = f.call('shield', **{'X-Spike-Crash': 'true', 'X-Spike-Operation': 'crash-once'})
        self.assertGreaterEqual(status, 500)
        wait_for(f.lock_available)
        self.assertEqual(len(f.events('execution_started')), 1)
        self.assertEqual(f.call('qwen')[0], 200)
        self.assertFalse(f.events('lock_conflict'))

    def test_duplicate_request_is_not_durable_idempotency(self):
        f = self.fixture()
        for _ in range(2):
            self.assertEqual(f.call('shield', **{'X-Spike-Operation': 'same-operation'})[0], 200)
        self.assertEqual(len(f.events('execution_started')), 2)
        self.evidence['duplicateHttpExecutesTwice'] = True

    def test_client_disconnect_does_not_replay_execution(self):
        f = self.fixture()
        status, _ = f.request('/upstream/shield/classify', {'image': 'c3ludGhldGlj'},
                              {'X-Spike-Delay': '1', 'X-Spike-Operation': 'disconnect-once'}, timeout=0.3)
        self.assertEqual(status, 0)
        wait_for(lambda: f.events('execution_finished'))
        self.assertEqual(len(f.events('execution_started')), 1)
        self.assertEqual(f.request('/running')[0], 200)
        self.evidence['disconnectAutomaticReplays'] = 0

    def test_proxy_sigkill_observes_orphan_and_restart_boundary(self):
        f = self.fixture()
        self.assertEqual(f.call('shield')[0], 200)
        pid = f.events('model_loaded')[0]['pid']
        f.proxy.kill()
        f.proxy.wait(timeout=3)
        time.sleep(0.25)
        orphan_alive = not dead(pid)
        held = not f.lock_available()
        self.evidence['proxySigkill'] = {'childRemainsAlive': orphan_alive, 'kernelLockStillHeld': held}
        f.start()
        self.assertEqual(f.request('/health')[0], 200)
        result = f.call('qwen')[0]
        self.evidence['proxySigkill']['newModelHttpStatus'] = result
        self.evidence['proxySigkill']['lockConflicts'] = len(f.events('lock_conflict'))
        # The existing kernel guard must prevent simultaneous fixture ownership even on crash.
        if orphan_alive and held:
            self.assertNotEqual(result, 200)
        else:
            self.assertEqual(result, 200)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve()
    version = subprocess.check_output([str(binary), '-version'], text=True).strip()
    if 'v255 (7761aa1)' not in version:
        raise SystemExit('Expected pinned llama-swap v255 (7761aa1), got ' + version)
    Compatibility.binary = binary
    start = time.monotonic()
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Compatibility))
    report = {'scope': 'real llama-swap + fake CPU custom HTTP services; no GPU/production',
              'platform': sys.platform, 'machine': platform.machine(),
              'pythonVersion': platform.python_version(), 'version': version,
              'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'testsRun': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors),
              'elapsedSeconds': round(time.monotonic() - start, 2),
              'evidence': Compatibility.evidence}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())
