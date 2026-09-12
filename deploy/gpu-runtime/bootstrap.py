"""Inject file-based credentials, then exec the manager as container PID 1."""
import json
import os
from pathlib import Path
import tempfile


def runtime_config():
    config = json.loads(Path(__file__).with_name('llama-swap.json').read_text())
    tokens = [Path('/run/secrets/' + name).read_text().strip()
              for name in ['shield_token', 'catalog_token']]
    if any(len(token) < 24 or not token.isascii() for token in tokens):
        raise ValueError('private_tokens_required')
    config['apiKeys'] = tokens
    return config


def main():
    fd, path = tempfile.mkstemp(prefix='llama-swap-', suffix='.json')
    with os.fdopen(fd, 'w') as handle:
        json.dump(runtime_config(), handle)
    # No resident shell/Python wrapper: failure of this PID terminates its namespace.
    os.execv('/usr/local/bin/llama-swap', ['llama-swap', '-config', path, '-listen', '0.0.0.0:8090'])


if __name__ == '__main__':
    main()
