FROM python:3.12-slim-trixie@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea
ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HUB_DISABLE_TELEMETRY=1 OMP_NUM_THREADS=2 TOKENIZERS_PARALLELISM=false
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch==2.8.0 torchvision==0.23.0 \
    --index-url https://download.pytorch.org/whl/cu128
RUN pip install --no-cache-dir transformers==4.57.6 accelerate==1.12.0 \
    pillow==12.2.0 sentencepiece==0.2.1
WORKDIR /app
COPY . /app
# Build contexts may be private (umask 077); the serving UID still needs code access.
RUN chmod -R a+rX /app
ENTRYPOINT ["python", "/app/server.py"]
