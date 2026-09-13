# Managed GPU rollout checkpoint — 2026-09-13

The real runtime image has been exercised in an isolated container on the RTX
4070. Production still uses the original ShieldGemma and Qwen services. This
runbook prepares a later owner-approved cutover; none of its production mutations
were executed by the pilot.

The pilot used Torch 2.8.0/CUDA 12.8, Transformers 4.57.6 for ShieldGemma and 5.17.0
for Qwen, the existing pinned model revisions, 2 CPU and 12 GiB container RAM. All
five serving-source hashes matched the application checkout at `6e08688f`.
One synthetic 384×384 JPEG was used. Cold/warm timings were 23.11/0.78 seconds for
ShieldGemma and 165.79/12.46 seconds for Qwen. A return switch to ShieldGemma took
87.85 seconds; another cold start after container recovery took 87.36 seconds.
These are individual observations, not latency percentiles or worst-case limits.

Idle TTL, forced retirement of a SIGSTOP-stalled child, PID-1 SIGKILL and container
restart were checked on the real GPU. Exit released FLOCK and returned global
used VRAM to the original 1,747 MiB held by the untouched legacy CUDA contexts.
The stopped-child test exercises the manager's forced-unload deadline; it does
not prove that a Python watchdog can run while its entire process is SIGSTOPped.
The PID-1 fault was injected with a resident model after its request completed.
Uncertain in-flight application recovery remains a separate test.

Qwen also completed a 130.64-second cold request while the deployed Jellyfin
image's FFmpeg performed synthetic 1080p30 H.264 CUDA decode and NVENC encoding.
All 135 resource samples had an active encoder. The video produced 4,068 frames
at approximately 30 fps, with no duplicated/dropped frames and speed at least
0.99x after startup. Peak global VRAM was 10,166 MiB, with at least 1,708 MiB free.
Jellyfin's service health remained responsive (maximum observed 69 ms).
This used a separate bounded codec container; Jellyfin client playback, 4K/HDR,
tone mapping, multiple streams and ShieldGemma/video coexistence were not tested.

The first video fixture failed when FFmpeg reinitialized CUDA filters at a short
clip's loop boundary (exit 218, no OOM). Its successful Qwen request had no video
overlap and is excluded from coexistence evidence. A finite continuous input then
passed a 12-second standalone codec check before the successful combined test.
The total budget remained 12 native requests: ten successful local inferences and
two pre-execution 429 refusals. No paid calls or production queue jobs were run.
All pilot containers, synthetic video and temporary credentials were removed;
the four production service PIDs, empty queue and original GPU baseline were
unchanged at the final check.

## Admission proposal

The deployed entrypoint currently enforces cooperative FLOCK only. The following
is a proposed policy for a subsequent bounded rollout, not an implemented global
scheduler or a guarantee for unprofiled inputs:

| Cold start | Observed additional GPU allocation | Proposed minimum free VRAM |
| --- | --- | --- |
| ShieldGemma | about 9,697 MiB | 10,752 MiB (10.5 GiB) |
| Qwen | about 8,085 MiB | 9,216 MiB (9 GiB) |

Use `memory.free` directly and measure after the previous process has exited and
released FLOCK. These initial thresholds reserve at least approximately 1 GiB
above the observed peaks. They do not include a second copy of an already
resident model. A resident-call policy needs a separately measured incremental
peak for the admitted image/token profile.

With the old idle CUDA contexts still present, ShieldGemma leaves only about
430 MiB free. Its video-coexistence launch was therefore refused by the pilot's
headroom check. Keep ShieldGemma plus transcoding closed until it is tested in a
separately approved cutover window with those old contexts gone. Do not stop the
old services just to make an isolated test pass.

For any initial activation, retain concurrency 1 and the tested input profile.
Before dispatch require a fresh resource sample, sufficient host MemAvailable
(starting proposal: 10 GiB), a responsive manager and uncontested lease. Unknown
GPU activity, unprofiled video/HDR/tone-mapping, multiple transcodes, larger images
or multiple-image Qwen prompts require separate profiling. An absent/stale sample
must defer the request. Return 429 only before execution; an ambiguous timeout
must follow failure/reconciliation handling, not pretend no execution happened.

Free VRAM at admission cannot stop another uncoordinated process starting later.
Jellyfin pre-start coordination and ongoing pressure monitoring remain necessary
before promising general coexistence. The current pilot used guards of 8 GiB
host MemAvailable and 350 MiB free VRAM to stop only its own workload if pressure
or unrelated queue activity appeared. Those emergency stop guards are not the
proposed production admission thresholds.

Do not shorten model deadlines from the fast warm timings. ShieldGemma cold
starts varied from 23 to 88 seconds against a 110-second backend watchdog and a
120-second worker timeout. Profile storage/cache pressure before increasing load;
any larger deadline needs coordinated worker/proxy changes.

## Prepare the cutover

Record the currently running web and legacy GPU image IDs, selected URLs,
container state, model mounts and serving UID. Preserve the current Compose and
relevant env files in a private owner-readable rollback directory. Do not export
credentials into the report. Keep the current application/DB revision; runtime
rollback does not require a database restore or downgrade.

Populate a private `gpu-runtime.env` containing only the reviewed immutable
`GPU_RUNTIME_IMAGE`, `SHIELD_MODEL_DIR`, `QWEN_MODEL_DIR` and, if different,
`MEDIA_LOCAL_NETWORK`. The model paths must come from the native containers'
read-only mounts. Confirm that the external network is internal and includes the
worker. The template refuses missing bind sources rather than creating empty
model directories.

Render the complete Compose configuration without launching it:

```sh
docker compose --project-name karakeep-gpu-runtime \
  --env-file /srv/appdata/karakeep/gpu-runtime.env \
  -f /srv/appdata/karakeep/compose.gpu-runtime.yaml config --quiet
```

Verify the worker credentials match the two existing token files using a local
boolean comparison; never print their values. The new URLs are:

```dotenv
MEDIA_AI_LOCAL_URL=http://gpu-lifecycle:8090/upstream/shield/classify
MEDIA_AI_LOCAL_CATALOG_URL=http://gpu-lifecycle:8090/upstream/qwen/catalog
```

On the inspected server the rollback URLs are
`http://sensitive-classifier:8091/classify` and
`http://local-catalog:8092/catalog`. Recheck them at the actual cutover.

The installed autodeployer replaces only `web` and treats `deploy/` changes as a
protected-tree change. Coordinate its timer/service and deployment lock for the
maintenance window; do not approve a new protected-tree digest merely to bypass
a guard. The current authoritative stack is
`/srv/appdata/karakeep/compose.yaml`. Make endpoint and service-state changes in
that maintained configuration so a later full-stack command cannot accidentally
reactivate both generations of GPU services.

## Activate only in the approved window

1. Prevent new dispatch/import release and wait for existing GPU and paid work to
   finish. Confirm the live queue and lease are idle; do not interrupt jobs.
   Coordinate the web container's worker lifecycle and the social enqueuer with
   the application owner. If there is no independent worker pause, account for a
   short web maintenance window rather than claiming a seamless hot change.
2. Stop the two idle legacy GPU services. Verify their process exit, shared lock
   release and the resulting VRAM baseline before starting the managed unit.
3. Start the managed unit using the rendered template and pinned image. Confirm
   PID 1, authenticated health, private network and file permissions. Health alone
   does not prove model readiness or available GPU capacity.
4. Change only the two worker URLs in their authoritative configuration, retaining
   the matching credentials and the current application image. Recreate the web
   service under the existing deployment procedure, then validate its health and
   authenticated access without a paid request.
5. Admit only the explicitly selected local-only sample. Observe resource waiting,
   model/process transitions, completion and return of memory. Expand neither
   concurrency nor import release based on a single successful sample. Resume
   other dispatch only after the agreed checks pass.

## Roll back the runtime

First stop new dispatch and let active work finish. Stop the managed unit and
verify that its entire PID namespace is gone, FLOCK is free and its GPU memory is
returned. Restore the captured legacy service configuration/images and the two
old URLs; start the legacy services and validate health before resuming workers.
Keep the current waiting-aware application and current database, including
retained imports and their revision-scoped processing permissions. Do not restore
an old DB or assume that an older image understands those records. Reconcile any
uncertain operation explicitly; never auto-replay a paid request. Finally restore
the prior autodeployment controls through their normal approval procedure.
