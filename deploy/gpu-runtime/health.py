import urllib.request
from pathlib import Path

request = urllib.request.Request('http://127.0.0.1:8090/health', headers={
    'Authorization': 'Bearer ' + Path('/run/secrets/shield_token').read_text().strip(),
})
with urllib.request.urlopen(request, timeout=3) as response:
    raise SystemExit(0 if response.status == 200 else 1)
