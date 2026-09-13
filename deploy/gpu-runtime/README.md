# Managed local GPU runtime

This integrates llama-swap v255 with Karakeep's existing native ShieldGemma and
Qwen services and SQLite/liteque queue. An isolated native GPU pilot was performed
on 2026-09-13; production activation remains a separate step. See the
[rollout checkpoint](ROLLOUT.md) for measured limits, admission proposals and
cutover/rollback. The existing model recipes,
revisions, native HTTP contracts and shared deferred-import authority remain in
place. No database migration or import release API is introduced here.

## Lifecycle and admission

`bootstrap.py` reads the two existing file credentials, writes a mode-0600 private
config under `/tmp`, and **execs llama-swap as container PID 1**. The manager owns
both model children in the same PID namespace. Do not replace this with a living
shell wrapper, separate sibling backend containers, or an in-container proxy-only
restart. Earlier Linux tests reproduced orphaned model processes with proxy-only
restart; restarting the whole container is the selected recovery boundary.

The exclusive `heavy` group switches between ShieldGemma and Qwen. Each has a
single request slot, 15-second idle TTL and 15-second unload timeout. Compatible
requests within that interval can reuse a resident model. Different models still
cause a process switch; the queue does not yet group or batch jobs by model.

The native entrypoint accepts one inference call at a time and keeps `/health`
responsive on separate bounded request threads. Immediately before the first
model invocation it attempts the shared kernel FLOCK without waiting. If another
cooperating process owns the lock, it returns **429 before model execution**. Once
acquired, the child retains the lock, model and CUDA context until process exit.
Subsequent calls reuse them. No per-call unload or early lease release occurs.
Health indicates a responsive control process, not available GPU capacity or
loaded weights. This differs intentionally from the older fake lifecycle probe,
where startup lock refusal surfaced as a proxy 5xx.

An independent watchdog kills the model process after 110 seconds for ShieldGemma
or 465 seconds for Qwen, including cold load. Unexpected model exceptions return
a sanitized 503 and retire the child. The manager owns switching and termination;
this entrypoint does not implement another model switcher. Worker transport
timeouts remain 120/480 seconds. Those margins must be measured on native GPU;
a switch plus cold start can still exhaust the client timeout.

## Queue behavior

- Native service 429 becomes `waiting_resource` in the existing `bookmarks.mediaAi`
  JSON, preserving the run ID and any valid ShieldGemma checkpoint. The existing
  `QueueRetryAfterError` defers delivery for 30 seconds without consuming a
  liteque failure attempt or reserving a paid request.
- Recovery scans up to 100 due waiting records and repairs missing queue delivery
  using the same idempotency key. Claim still checks current input/configuration
  and the shared deferred guard. Results arriving while waiting cannot be applied.
- Manual jobs have priority 0, automatic jobs 10; **lower values run first**.
  Waiting jobs yield their worker slot. This does not preempt a running request.
- HTTP 5xx, transport failures and malformed dispatched responses finish as
  `local_failed`; an unavailable classifier cannot trigger Qwen in the same run.
  Existing bounded local recovery remains. Unknown transport outcomes are not
  treated as a definitive resource refusal. Paid requests retain their existing
  ledger/no-replay behavior.
- UI shows resource waiting, continues polling and prevents duplicate enqueue.
  Shared import permissions are checked at request, claim, continuation, parking,
  recovery and result application. Since the controlled-processing release,
  verified imports can receive revision-scoped preview/search/local-check/catalog
  permits while remaining deferred. The runtime does not grant or bypass permits.

The current worker still has concurrency 1. There are no independent CPU/cloud
lanes, weighted fairness, model micro-batches, measured VRAM/RAM admission, or
Jellyfin coordination in this slice. FLOCK only coordinates processes using that
same lock; it does not constrain unrelated GPU consumers. Waiting has no maximum
age and depends on the existing recovery loop; monitoring/operator cancellation
and a richer reconciliation state machine remain future work.

## Image and private networking

Build with `deploy/` as context and immutable digests for the reviewed existing
backend images. Both must use the pinned Python 3.12 slim-trixie base in the native
Dockerfiles. Qwen remains at `/usr/local`; ShieldGemma's entire Python prefix is
copied to `/opt/shield-python` and runs with its own `PYTHONHOME`. This preserves
their different Transformers versions (5.17.0 and 4.57.6). Native imports and
single-image GPU inference were subsequently verified with both stacks. This
does not validate every input profile or future dependency/image change.

```sh
docker build --platform linux/amd64 \
  --build-arg SHIELD_IMAGE="$SHIELD_IMAGE_DIGEST" \
  --build-arg QWEN_IMAGE="$QWEN_IMAGE_DIGEST" \
  --tag karakeep-gpu-lifecycle:review \
  --file deploy/gpu-runtime/Dockerfile deploy
docker compose --env-file /path/to/verified-runtime.env \
  -f deploy/gpu-runtime/compose.example.yml config --quiet
```

The two build arguments are deliberately required (Docker emits
`InvalidDefaultArgInFrom` warnings without defaults). The build verifies both
archive and executable SHA256 for the official v255 Linux amd64 binary. Runtime
model access is offline. `/tmp` is transient; config credentials must not be
printed or included in exported logs.

`compose.example.yml` is an integration template, not a separately enabled stack.
Adapt it within the existing deployment, verifying actual image digests, secret
paths, serving UID, NVIDIA CDI support and the existing internal network. Use the
same Linux lock-file bind as other cooperating consumers. No published host port,
Docker socket or archive mount is required.
The template requires `GPU_RUNTIME_IMAGE`, `SHIELD_MODEL_DIR` and `QWEN_MODEL_DIR`.
Set them from the verified image and the existing native containers' model mounts;
do not assume that model weights live under `/srv/appdata/karakeep/models`.
Missing bind sources fail instead of silently creating empty directories. The
template joins the existing `karakeep_media-local` network (override through
`MEDIA_LOCAL_NETWORK` when appropriate); it does not create a disconnected network
for a second Compose project. Verify that this existing network is internal.
Only the worker needs the private service URLs:

```dotenv
MEDIA_AI_LOCAL_URL=http://gpu-lifecycle:8090/upstream/shield/classify
MEDIA_AI_LOCAL_CATALOG_URL=http://gpu-lifecycle:8090/upstream/qwen/catalog
```

Keep the corresponding existing worker token values matching their file mounts.
Both tokens authenticate the manager; each native POST also checks its specific
token. Keep manager control APIs on the trusted internal network.

## Verification and pilot boundary

CPU verification covers real process FLOCK lifetime, external-owner 429, warm
load guard, responsive health, hard deadline, sanitized failure, SQLite queue
priority/attempt semantics, persisted waiting/deferred guards, worker routing and
UI polling. The actual Dockerfile was also built using two tiny synthetic Python
images, with the real v255 binary, bootstrap and native entrypoints: PID 1,
private config, prefix isolation, auth and both 429 routes were verified without
Torch, GPU or inference.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s deploy/gpu-runtime -v
env -u NO_COLOR pnpm --filter @karakeep/workers exec vitest run \
  workers/inference/mediaCatalogWorker.test.ts \
  workers/inference/mediaLocalProvider.test.ts \
  workers/inference/mediaLocalCatalogProvider.test.ts \
  workers/inference/mediaPipeline.integration.test.ts
env -u NO_COLOR pnpm --filter @karakeep/trpc exec vitest run \
  models/mediaCatalog.test.ts routers/deferredImport.test.ts
env -u NO_COLOR pnpm --filter @karakeep/plugins exec vitest run \
  --config queue-liteque/vitest.config.ts queue-liteque/src/tests/resourceWait.test.ts
```

The later native pilot verified repeated calls, both switch directions, VRAM
return, external lock contention, forced unload and PID-1 recovery. Before
activation, review its workload limits in [ROLLOUT.md](ROLLOUT.md) and use the
verified immutable image. Recheck any dependency change and profile larger inputs,
deadlines and Jellyfin workloads before widening admission or concurrency. This
change does not authorize production activation or additional import release.

For a later cutover, quiesce the affected workers and let existing calls drain,
stop the two old GPU services, start the common lifecycle unit, then change the
worker URLs and resume the explicitly chosen workload. Never run old and new
services as competing owners during cutover. For rollback, stop dispatch, stop
the lifecycle unit to release all contexts, restore the previous service images
and URLs, and only then resume. Keep the waiting-aware application version while
waiting records exist; downgrading its enum/schema blindly can break reads.
