# Hybrid media catalog

The catalog queue prepares up to three local JPEGs (768px, at most 2 MiB each).
For a single video it samples the start, middle and near-end; a carousel or mixed
post uses up to three assets. This is **sampled coverage**, not a complete video
or archive scan. ShieldGemma checks the exact outgoing JPEG bytes.

With hybrid enabled and local mode `enforce`:

| Admission | Catalog route |
| --- | --- |
| Any native `sexual`, `dangerous`, or `violence` match | Local Qwen |
| Unknown, malformed, partial or unavailable check | Local Qwen |
| Manually assigned Sensitive category | Local Qwen |
| Text-only archive (ShieldGemma does not check text) | Local Qwen |
| Explicit `localOnly` job | Local Qwen, including clean samples |
| All expected sampled frames pass and no manual hold | Configured cloud provider |

The selected local model is the ordinary **Qwen/Qwen3.5-9B**, revision
`c202236235762e1c871ad0ccb60c8ee5ba337b9a`. It uses NF4 double quantization,
BF16 vision/head, SDPA, thinking disabled, a bounded constrained JSON response,
and the tokenizer's explicit EOS token. The recipe is versioned in both the
service response and job fingerprint. A mismatched model/recipe is rejected.
Descriptions are neutral catalog metadata; they do not change moderation labels.
The generation grammar constrains JSON shape; string lengths and tag counts are
validated separately by Python and TypeScript. The pinned grammar library with
length constraints terminated a Russian synthetic answer mid-string in the GPU
canary. Shape-only generation passed; incomplete answers remain failures.

Qwen failures remain `local_failed`. There is **no cloud fallback**, including
timeouts and refusals. Local work does not reserve cloud quota. Durable recovery
permits at most two automatic local recoveries; uncertain cloud work is never
replayed automatically. A changed attachment event during a run retains a free
local follow-up intent. Manual fields and deleted tags are preserved, stale
results are discarded, and provenance belongs to the saved result rather than
the latest failed attempt.

## Outgoing data

Hybrid cloud requests include only admitted sampled JPEGs and media-kind/count
metadata. Source titles/captions/authors and existing tags are omitted because
ShieldGemma is not a text classifier. This can reduce contextual naming quality.
Text-only items are analyzed locally. File paths, URLs, private notes and bookmark
IDs are never sent to the local service either.

Legacy inference/summary and embedding clients are disabled while hybrid mode is
enabled: those paths lack admission for their own payloads and could otherwise
upload locally generated text. Local full-text search remains available. Adding
those features back requires a separate payload-aware route.

Work/Balanced/Show all and temporary reveal affect display only. A manual clear
does not override a positive ShieldGemma admission check. Native negatives do
not certify an entire post or guarantee cloud-provider acceptance.

## Provisioning (not automatic deployment)

Build from the repository root:

```sh
docker build -t karakeep-local-catalog:hybrid-review -f deploy/local-catalog/Dockerfile deploy
docker build -t karakeep-sensitive-classifier:hybrid-review deploy/sensitive-classifier
```

Download and verify the pinned official Qwen snapshot outside the serving
container. The read-only model directory must include a `download-manifest.json`
with `model` and `revision`. The manifest identifies an already verified snapshot;
it is not a runtime checksum check of every weight. No HF token or model download
is available to the running service. Custom checkpoint code is disabled.

`compose.example.yml` contains placeholders for host paths and service UID/GID.
Prepare a private directory writable by those UIDs at the shared GPU lease path.
Both services **must use the same bind-mounted lease file**, and the classifier
must be rebuilt with lease support. Do not remove/recreate the lock inode while
either service is running. Both unload tensors/cache before releasing ownership;
the lock stays held through cold loading and inference. This prevents overlap
between these two services, not unrelated GPU applications.

The conservative first version unloads after every request, so cold loading adds
latency (the paired pilot measured roughly two minutes for Qwen on two CPUs).
This favors bounded residency on a shared 12 GiB GPU over warm throughput. A
shared warm-model scheduler is a separate optimization. Worker concurrency is
one; hybrid job timeout is 900s, stale recovery starts at 960s. The Qwen service
has a 465s hard process deadline and the client times out at 480s. A lost client
may leave bounded local work running until the service deadline, never a cloud
retry. CPU/RAM/no-swap limits remain per-container; loading both is serialized.

Use separate random ASCII bearer tokens (at least 24 characters) in private
host files, not in this repository. The worker requires matching secret values.
Join the worker to the internal `media-local` network while retaining its existing
cloud network. Do not publish either model port or attach model containers to an
internet-enabled network. The model services receive no archive mount or cloud
credentials. `/health` checks the HTTP process only, not model/CUDA readiness.

New settings default off. For a **manual hybrid canary** after deployment:

```dotenv
MEDIA_AI_ENABLED=true
MEDIA_AI_HYBRID_ENABLED=true
MEDIA_AI_LOCAL_MODE=enforce
MEDIA_AI_LOCAL_URL=http://sensitive-classifier:8091/classify
MEDIA_AI_LOCAL_CATALOG_URL=http://local-catalog:8092/catalog
MEDIA_AI_AUTO_NEW=false
MEDIA_AI_LOCAL_AUTO_NEW=false
# MEDIA_AI_LOCAL_TOKEN and MEDIA_AI_LOCAL_CATALOG_TOKEN come from private config.
# The existing provider, model, cloud key and daily quota remain configured.
```

After approval of the canary, `MEDIA_AI_AUTO_NEW=true` enables newly saved archive
analysis. Leave `MEDIA_AI_LOCAL_AUTO_NEW=false` for hybrid automatic routing;
setting it true deliberately chooses local-only jobs instead. Existing persisted
local-only intent is never upgraded to cloud work. Changing the fingerprint
invalidates older queued jobs. No existing-card backfill is run on startup.
`review` continues to stop after local admission without generating catalog text.
With hybrid enabled, `localMode=off` fails closed rather than restoring cloud.
To pause the pipeline set `MEDIA_AI_ENABLED=false`; disabling hybrid itself
restores the legacy configuration behavior and must not be used as a pause.

## Verification

```sh
python3 -m unittest discover -s deploy/local-catalog -p 'test_*.py'
python3 -m unittest discover -s deploy/sensitive-classifier -p 'test_*.py'
```

`smoke.py` runs the actual HTTP service on a generated shape and a synthetic text
note, checks authentication, pinned provenance and the JSON contract. Run it in
the built image with `--network none`, a read-only verified model mount, bounded
resources and an exclusively available GPU. It does not access the archive or
call Grok. GPU/model quality and full production ingestion are separate checks.

### Implementation verification, 2026-09-12

The service passed a network-disabled RTX 4070 canary using the existing pinned
pilot runtime (`karakeep-model-eval:qwen9-json-compat-20260912`), with these
serving sources mounted read-only: one synthetic JPEG and one text note, valid
JSON and pinned provenance, HTTP authentication checked. Requests took 28.69s
and 42.86s including per-request model loading; host filesystem cache was warm
from the pilot, so these are not worst-case cold-start times. No archive or cloud
credentials were mounted. Production workers were restored after each test; the
cloud ledger stayed unchanged. This does not validate a production rollout or
prove the correctness of generated descriptions. The new Dockerfile still needs
a full build and canary of the resulting image as part of deployment review.
