# Build with deploy/ as context. Supply immutable existing backend image digests.
# Their distinct Transformers/Python environments stay separate in one PID namespace.
ARG SHIELD_IMAGE
ARG QWEN_IMAGE
FROM ${SHIELD_IMAGE} AS shield
FROM python:3.12-slim-trixie@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea AS download
RUN python - <<'PY'
import hashlib, io, tarfile, urllib.request
from pathlib import Path
url = 'https://github.com/mostlygeek/llama-swap/releases/download/v255/llama-swap_255_linux_amd64.tar.gz'
data = urllib.request.urlopen(url, timeout=60).read()
assert hashlib.sha256(data).hexdigest() == '84aa0df0cf3e302a8591e39de347f64c0c7dce1c3a948df68723a82e1fb4f1d4'
with tarfile.open(fileobj=io.BytesIO(data)) as source:
    binary = source.extractfile('llama-swap').read()
assert hashlib.sha256(binary).hexdigest() == '43e402d6c9f3e6001f5821c3cda35077676cec486a8dcf26d2b780ada01302eb'
Path('/llama-swap').write_bytes(binary)
Path('/llama-swap').chmod(0o755)
PY
FROM ${QWEN_IMAGE}
COPY --from=shield /usr/local/ /opt/shield-python/
COPY --from=download /llama-swap /usr/local/bin/llama-swap
COPY sensitive-classifier/ /opt/deploy/sensitive-classifier/
COPY local-catalog/ /opt/deploy/local-catalog/
COPY gpu-runtime/ /opt/deploy/gpu-runtime/
RUN chmod -R a+rX /opt/deploy /opt/shield-python
ENV PYTHONDONTWRITEBYTECODE=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 TOKENIZERS_PARALLELISM=false OMP_NUM_THREADS=2
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["python", "/opt/deploy/gpu-runtime/health.py"]
ENTRYPOINT ["python", "/opt/deploy/gpu-runtime/bootstrap.py"]
