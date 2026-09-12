# Build with deploy/ as context, not this directory.
FROM python:3.12-slim-trixie@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea
ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 HF_HUB_DISABLE_TELEMETRY=1 \
    OMP_NUM_THREADS=2 TOKENIZERS_PARALLELISM=false PYTHONDONTWRITEBYTECODE=1
RUN pip install --no-cache-dir torch==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
RUN pip install --no-cache-dir transformers==5.17.0 accelerate==1.15.0 \
    bitsandbytes==0.50.2 safetensors==0.8.0 pillow==12.2.0 lm-format-enforcer==0.11.3
# Compatibility correction verified in the paired Qwen pilot (Transformers 5).
RUN python -c "from pathlib import Path; import lmformatenforcer; p=Path(lmformatenforcer.__file__).parent/'integrations/transformers.py'; s=p.read_text(); old='from transformers.tokenization_utils import PreTrainedTokenizerBase'; assert old in s; p.write_text(s.replace(old, 'from transformers.tokenization_utils_base import PreTrainedTokenizerBase'))"
WORKDIR /app
COPY local-catalog/ /app/
COPY sensitive-classifier/gpu_lease.py /app/gpu_lease.py
# Build contexts may be private (umask 077); the serving UID still needs code access.
RUN chmod -R a+rX /app
ENTRYPOINT ["python", "/app/server.py"]
