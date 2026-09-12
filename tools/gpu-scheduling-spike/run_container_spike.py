#!/usr/bin/env python3
"""Verify whole-container lifecycle with an existing local Docker Linux image."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid


class Containers:
    def __init__(self, args, state):
        self.args = args
        self.state = state
        self.owned = []
        self.volume = None
        self.repo = Path(__file__).resolve().parents[2]

    def docker(self, *command, timeout=35):
        result = subprocess.run(['docker', '--context', self.args.context, *command],
                                capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError('Docker fixture command failed: ' + result.stderr[-2000:])
        return result.stdout.strip()

    def flags(self, user=None):
        mounts = [
            (self.repo / 'tools/gpu-scheduling-spike', '/repo/tools/gpu-scheduling-spike', True),
            (self.repo / 'deploy/sensitive-classifier/shieldgemma.py',
             '/repo/deploy/sensitive-classifier/shieldgemma.py', True),
            (self.repo / 'deploy/local-catalog/contract.py', '/repo/deploy/local-catalog/contract.py', True),
            (self.args.binary.resolve(), '/binary/llama-swap', True),
            (self.state, '/fixture', True),
        ]
        flags = ['--pull', 'never', '--platform', 'linux/amd64', '--network', 'none',
                 '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                 '--memory', '384m', '--memory-swap', '384m', '--cpus', '1', '--pids-limit', '128',
                 '--user', user or '%d:%d' % (os.getuid(), os.getgid()),
                 '--tmpfs', '/tmp:rw,nosuid,nodev,size=67108864,mode=1777',
                 '--env', 'PYTHONDONTWRITEBYTECODE=1']
        for source, target, readonly in mounts:
            if ',' in str(source):
                raise ValueError('Fixture mount paths cannot contain commas')
            flags += ['--mount', 'type=bind,src=%s,dst=%s%s' %
                      (source, target, ',readonly' if readonly else '')]
        if self.volume:
            flags += ['--mount', 'type=volume,src=%s,dst=/state' % self.volume]
        return flags

    def initialize_storage(self):
        name = 'karakeep-synthetic-gpu-' + uuid.uuid4().hex
        self.volume = self.docker('volume', 'create', '--label', 'karakeep.synthetic-gpu-spike=true', name)
        # Set permissions only on this newly-created empty fixture volume.
        self.docker('run', '--rm', *self.flags(user='0:0'), '--entrypoint', '/usr/bin/python3',
                    self.args.image, '-c', "import os; os.chmod('/state', 0o777)")

    def create(self, executable, *arguments):
        identifier = self.docker('create', *self.flags(), '--restart', 'no',
                                 '--label', 'karakeep.synthetic-gpu-spike=true',
                                 '--entrypoint', executable, self.args.image, *arguments)
        self.owned.append(identifier)
        self.docker('start', identifier)
        return identifier

    def request(self, identifier, path, body=None):
        # Only synthetic inputs reach this code; no response body is exported.
        script = '''import json, urllib.request, urllib.error
body = BODY
request = urllib.request.Request('http://127.0.0.1:62000' + PATH,
    data=None if body is None else json.dumps(body).encode(),
    headers={'Authorization': 'Bearer fake-private-token', 'Content-Type': 'application/json'})
try:
    with urllib.request.urlopen(request, timeout=15) as response: print(response.status)
except urllib.error.HTTPError as error: print(error.code)
except (OSError, urllib.error.URLError): print(0)
'''.replace('BODY', repr(body)).replace('PATH', repr(path))
        return int(self.docker('exec', identifier, '/usr/bin/python3', '-c', script))

    def lock_available(self, identifier=None):
        script = '''import fcntl, json
with open('/state/gpu.lock', 'a') as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print('true')
    except BlockingIOError: print('false')
'''
        if identifier:
            return json.loads(self.docker('exec', identifier, '/usr/bin/python3', '-c', script))
        return json.loads(self.docker('run', '--rm', *self.flags(), '--entrypoint',
                                     '/usr/bin/python3', self.args.image, '-c', script))

    def wait(self, condition):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if condition():
                return
            time.sleep(0.1)
        raise AssertionError('Timed out waiting for container fixture evidence')

    def close(self):
        for identifier in reversed(self.owned):
            self.docker('rm', '--force', identifier)
        if self.volume:
            self.docker('volume', 'rm', self.volume)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--context', required=True)
    parser.add_argument('--image', required=True, help='Existing pinned Docker image ID, with Python3 and ps')
    parser.add_argument('--binary', type=Path, required=True, help='Verified v255 Linux amd64 binary')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not args.image.startswith('sha256:') or len(args.image) != 71:
        raise SystemExit('Use an immutable existing Docker image ID')
    if hashlib.sha256(args.binary.read_bytes()).hexdigest() != \
            '43e402d6c9f3e6001f5821c3cda35077676cec486a8dcf26d2b780ada01302eb':
        raise SystemExit('Expected the verified v255 Linux amd64 executable digest')
    args.output = args.output.resolve()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    report = {'scope': 'local Docker Linux amd64, fake CPU; no GPU/models/production',
              'image': args.image, 'binarySha256': hashlib.sha256(args.binary.read_bytes()).hexdigest(),
              'stateStorage': 'private Docker-native volume', 'checks': {}, 'passed': False}
    with tempfile.TemporaryDirectory(prefix='.llama-container-spike-', dir=args.output.parent) as temporary:
        state = Path(temporary)
        c = Containers(args, state)
        endpoint = c.docker('context', 'inspect', args.context, '--format', '{{.Endpoints.docker.Host}}')
        if not endpoint.startswith('unix://'):
            raise SystemExit('This fixture only accepts a local Unix-socket Docker context')
        report['dockerEngine'] = c.docker('version', '--format', '{{.Server.Version}} {{.Server.Os}} {{.Server.Arch}}')
        models = {}
        for name, port in [('shield', 62001), ('qwen', 62002)]:
            models[name] = {'cmd': '/usr/bin/python3 /repo/tools/gpu-scheduling-spike/fake_backend.py '
                            '--name %s --port %d --events /state/events.jsonl --lock /state/gpu.lock' % (name, port),
                            'proxy': 'http://127.0.0.1:%d' % port, 'checkEndpoint': '/health',
                            'ttl': 0, 'unloadTimeout': 1, 'concurrencyLimit': 1}
        (state / 'config.json').write_text(json.dumps({
            'logLevel': 'error', 'captureBuffer': 0, 'performance': {'disabled': True},
            'healthCheckTimeout': 5, 'models': models,
            'routing': {'router': {'use': 'group', 'settings': {'groups': {
                'heavy': {'swap': True, 'exclusive': True, 'members': ['shield', 'qwen']}}}}}}))
        try:
            c.initialize_storage()
            # Start with a separate process namespace holding the kernel guard.
            holder = c.create('/usr/bin/python3', '-c',
                              "import fcntl,time; f=open('/state/gpu.lock','a'); "
                              "fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); time.sleep(120)")
            c.wait(lambda: 'locked' in c.docker('logs', holder))
            report['lockProbe'] = {'sameContainerAvailable': c.lock_available(holder),
                                   'otherContainerAvailable': c.lock_available()}
            c.wait(lambda: not c.lock_available())
            proxy = c.create('/binary/llama-swap', '-config', '/fixture/config.json',
                             '-listen', '127.0.0.1:62000')
            c.wait(lambda: c.request(proxy, '/health') == 200)
            assert c.request(proxy, '/upstream/shield/classify', {'image': 'c3ludGhldGlj'}) >= 500
            assert not c.lock_available()
            report['checks']['externalOwnerDeniedWhileProxyHealthy'] = True

            c.docker('kill', '--signal', 'KILL', holder)
            c.wait(c.lock_available)
            assert c.request(proxy, '/upstream/shield/classify', {'image': 'c3ludGhldGlj'}) == 200
            assert not c.lock_available()
            report['checks']['dispatchSucceedsAfterExternalOwnerExit'] = True

            # llama-swap is PID 1: killing it terminates this complete container unit.
            command = c.docker('exec', proxy, '/usr/bin/python3', '-c',
                               "print(open('/proc/1/comm').read().strip())")
            assert command == 'llama-swap', command
            c.docker('kill', '--signal', 'KILL', proxy)
            assert c.docker('inspect', proxy, '--format', '{{.State.Running}}') == 'false'
            c.wait(c.lock_available)
            report['checks']['proxyPid1SigkillStopsUnitAndReleasesLock'] = True

            c.docker('start', proxy)
            c.wait(lambda: c.request(proxy, '/health') == 200)
            payload = {'media': {'kind': 'text', 'coverage': 'archived_text', 'asset_count': 0,
                                 'sampled_images': 0},
                       'source': {'title': '', 'caption': 'Synthetic fixture', 'author': ''}, 'images': []}
            assert c.request(proxy, '/upstream/qwen/catalog', payload) == 200
            event_log = c.docker('exec', proxy, '/usr/bin/python3', '-c',
                                 "print(open('/state/events.jsonl').read())")
            rows = [json.loads(line) for line in event_log.splitlines()]
            assert len([row for row in rows if row['kind'] == 'execution_started']) == 2
            assert len([row for row in rows if row['kind'] == 'lock_conflict']) == 1
            report['checks']['containerRestartAcceptsNextModelWithoutReplay'] = True

            c.docker('stop', '--time', '5', proxy)
            c.wait(c.lock_available)
            report['checks']['gracefulContainerStopReleasesLock'] = True
            report['passed'] = True
        except BaseException:
            report['failureContainers'] = [{'state': c.docker('inspect', identifier, '--format', '{{json .State}}'),
                                             'logs': c.docker('logs', identifier)[-2000:]}
                                            for identifier in c.owned]
            raise
        finally:
            c.close()
            report['ownedContainersRemoved'] = len(c.owned)
            report['ownedVolumesRemoved'] = 1 if c.volume else 0
            args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
