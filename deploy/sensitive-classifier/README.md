# Private ShieldGemma CUDA classifier

Build from this directory. The service expects an already downloaded model at
`/models`, including `download-manifest.json` with the pinned `model` and `revision`
listed in `shieldgemma.py`. The manifest identifies the snapshot; it is not a runtime
checksum verification of every weight file. Provision/verify the snapshot before
mounting it read-only. No model download happens while serving requests.

`compose.example.yml` is an isolated service example, not a production override.
Replace the host paths, numeric user/group and pinned image with the reviewed values.
The existing Karakeep **worker process** must join the same internal network; keep its
normal network for Grok. Do not publish the classifier port or attach it to the
worker's internet-enabled network. The server only needs connectivity to the worker.

The token file must contain a random ASCII token of at least 24 characters, readable
by the service UID and protected on the host. Put the matching value in the worker's
private `MEDIA_AI_LOCAL_TOKEN` configuration. No token is supplied in this repository.
Keep `MEDIA_AI_LOCAL_MODE=review` and automatic analysis off for the first pilot.

```sh
docker build -t karakeep-sensitive-classifier:shieldgemma-review .
python -m unittest discover -p 'test_*.py'
```

The configured runtime requires NVIDIA CDI (`nvidia.com/gpu=0`). It limits host RAM
to 12 GiB without swap, CPU to 2 and processes to 256. Model weights are read-only,
temporary data lives in tmpfs, and no archive volume is exposed. `GET /health` only
checks the HTTP process; it does not load the model or certify CUDA readiness.
Use `smoke.py` inside the image with a read-only model mount and `--network none`
for a real GPU check: it starts the service, generates two synthetic JPEGs, checks
responses/authentication and exits. It neither reads user media nor contacts Grok.

Stop the test service after a pilot if it is no longer needed. To pause production
AI processing, set `MEDIA_AI_ENABLED=false`; setting local mode to `off` instead
restores the direct cloud path. Keep stored local observations for diagnosis.

## Model and response contract

The selected model is `google/shieldgemma-2-4b-it`, revision
`eaf60452b5fc41a911338a022e628b0c15283897`, in BF16. Accept its Hugging Face
agreement and download/verify the pinned snapshot before deployment. Provision
`/srv/appdata/karakeep/models/shieldgemma` (or change the read-only mount to an
existing verified snapshot). The serving container never receives the HF token.

The three native policies are `sexual`, `dangerous`, and `violence` (including
graphic violence/gore). A complete response contains every finite score in [0,1]
and the categories whose score is at least 0.5. The application independently
validates that relationship. Missing or invalid scores become `unknown`, with
null scores and no asserted labels. Scores are not calibrated probabilities.

These native observations do not identify separate nudity, revealing clothing,
self-harm, drug, or extremism labels. Keep manual categories separate. No native
match means no match to these three policies on the sampled images, not a clean
bill for all Sensitive categories or an assurance of cloud-provider acceptance.

The pinned Transformers runtime needs two compatibility fixes, verified in the
pilot: set SDPA on the supported Gemma3 backbone after constructing the wrapper,
and tie the output head to its trained input embeddings. Otherwise eager vision
attention can exhaust VRAM, and the untied random output head produces invalid
predictions. Loading rejects all other missing/mismatched/unexpected weights and
checks the native-policy digest before serving images. See the
[reported weight-tying bug](https://huggingface.co/google/shieldgemma-2-4b-it/discussions/10).

Old Nemotron checkpoints remain readable in bookmark history but cannot be reused
for ShieldGemma admission. Policy/model revisions are part of the job fingerprint.
The service retains sequential requests, a 110-second hard process deadline and
unloads after 120 idle seconds. Do not run another large model concurrently on the
same 12 GiB GPU without a resource budget; this service does not coordinate other
applications' GPU allocation.

## Shared GPU with Qwen

When `GPU_LOCK_FILE` is configured, the classifier acquires a cooperative file lock before loading, then unloads after **each request** before releasing the lock. The 120-second warm idle retention applies only without a lease. Use the shared bind mount and deployment procedure in [the hybrid catalog guide](../local-catalog/README.md). Deploying Qwen alongside an older classifier image does not provide mutual exclusion.
