# llama-swap compatibility spike

This harness checks whether an existing model lifecycle manager can proxy
Karakeep's custom HTTP contracts before implementing a new supervisor. It runs a
real, pinned llama-swap executable against synthetic Python CPU services. It does
not run the production classifier/catalog servers, load model weights, access a
database, contact a cloud model, or use a GPU.

## Run

Requirements: Unix with `flock`, `ps`, Python 3.9+, and an executable from the
[llama-swap v255 release](https://github.com/mostlygeek/llama-swap/releases/tag/v255).
The harness checks version `v255 (7761aa1)`. Independently verify the selected
platform asset against the release checksums before executing it. No download or
system installation is performed by these scripts.

Run from this worktree, using absolute paths for the binary and report:

```sh
python3 tools/gpu-scheduling-spike/run_spike.py \
  --binary /absolute/path/to/verified/llama-swap \
  --output /absolute/path/to/scratch/spike.json
```

The verified macOS arm64 archive had SHA-256
`d11b4c733da1c64ffd1b955f64b6af92a8c66a443aeeafeef2e84d3bf1fbf531`.
Its extracted executable had SHA-256
`8f826064a5eddb1ca7c4337fe8dd0e35377cb22044a2c983b7ef88ae1748e243`.
Other platform binaries will have different digests. Upstream source commit:
`7761aa13360ea379cb89366d07c2d08aa9f1ed10`.

Each fixture uses its own private temporary directory and three loopback ports
chosen with OS port-0 allocation, not llama-swap's fixed default start port. Port
selection and process binding are separate, so a concurrent port claim can still
fail a fixture. All requests use invented payloads and a fake bearer token. The
config disables request/response capture and performance monitoring. Cleanup
signals only the fixture's proxy handles and recorded child PIDs.

## What the ten tests establish

- Custom `/upstream/shield/classify` and `/upstream/qwen/catalog` transport,
  using response helpers and validation from the existing repository contracts.
  Image bytes are synthetic and no image decoder or model is exercised.
- Invalid authentication and invalid request responses pass through without
  starting synthetic execution.
- Three sequential classifier calls reuse one child process.
- `/running` responds while a synthetic request is active; a second request to
  the same model gets 429 with `concurrencyLimit: 1`.
- Switching models drains the active request and waits for the previous child
  to exit. The fixture holds a real kernel FLOCK for its simulated residency.
- Idle TTL and bounded forced unload terminate the child and release its lock.
- Backend failure and client disconnect do not automatically replay the tested
  request. This is an observation for these cases, not an exactly-once guarantee.
- Repeated identical HTTP calls execute twice: llama-swap does not supply the
  application's durable operation idempotency.
- After proxy SIGKILL, the test records child/lock ownership and restarts the
  proxy. On macOS v255 the orphan remains; the independent FLOCK prevents a new
  model from taking ownership, returning HTTP 500. A passing test here records a
  known recovery gap, not successful automatic orphan cleanup.

## Integration decision

Reuse llama-swap for launch, switching, TTL and HTTP proxying. Keep durable job
state, waiting-resource outcomes, fair admission, import permits, revision checks,
and paid-operation accounting in Karakeep. No database schema or processing-policy
authority is introduced by this spike.

The pinned v255 config has **per-model** `concurrencyLimit`; the
`globalConcurrencyLimit` found in later main-branch documentation is not available
in this release. Do not copy a main config into a pinned deployment. The fixture
uses one exclusive swapping group; this is not a global GPU admission policy.

Real backends still require residency changes: preserve the loaded model across
calls, add the Qwen already-loaded guard, and make readiness/control responsive.
Running their current per-request-unload implementation behind a proxy would not
remove reloads. Future process/container integration must have one lifecycle
owner and verifiable cleanup after proxy failure. Preserve the kernel guard;
after a crash, do not infer that GPU memory is free from `/health`, a lease timer,
or an in-memory list of running models.

## Pilot sequence

1. Re-run this fake-only harness on isolated Linux with a verified v255 binary;
   compare orphan behavior. Do not connect it to production ports or model paths.
2. Verify the chosen container/process supervision arrangement using fake
   services, including supervisor kill, restart, stale owner reconciliation and
   externally held lock. Limit start/stop authority to the two allowed services.
3. Integrate application admission only after the shared deferred-import
   foundation handoff. `stagePermits: false` and held outbox events do not authorize
   inference. A cloud request must never hold the local GPU lease.
4. In a separately authorized model pilot, measure load/unload time, real VRAM
   reclamation, RAM pressure and cancellation behavior before choosing residency
   limits. Test Jellyfin playback/coexistence separately. The initial macOS run
   did not establish Linux/Docker behavior; the later checkpoint below covers
   fake container lifecycle, still without GPU capacity or production evidence.

Reference configuration: [v255 config example](https://github.com/mostlygeek/llama-swap/blob/v255/docs/config.example.yaml).

## Linux container lifecycle checkpoint

The owner accepted llama-swap plus the existing Karakeep queue on 2026-09-12.
The same ten compatibility tests passed in a local Docker Linux amd64 container
(Python 3.12.3), emulated on an arm64 Docker Desktop host. The ordinary child
proxy SIGKILL orphan was reproduced there. These are CPU lifecycle results,
not performance measurements or NVIDIA runtime evidence.

`run_container_spike.py` checks the proposed **whole-container ownership**:
llama-swap runs as PID 1, and both fake backends are children in that container's
PID namespace. It verifies five behaviors:

1. An independent container holding the shared FLOCK prevents model execution,
   even though the proxy's `/health` returns 200.
2. Dispatch succeeds after that owner exits and the lock is released.
3. SIGKILL of the proxy at PID 1 stops the entire container and releases the lock.
4. Restarting the container accepts the next model without replaying prior work.
5. Graceful container stop also releases the lock.

All five passed. The Linux kernel terminates other processes when their namespace
init exits; see [pid_namespaces(7)](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html).
This result does not cover models started in sibling containers via `cmdStop`, a
shell wrapper that stays alive after the manager exits, or a worker that restarts
only the proxy inside a surviving container. Keep the tested lifecycle boundary.

Run against an **existing** local image containing `/usr/bin/python3` and `ps`:

```sh
python3 tools/gpu-scheduling-spike/run_container_spike.py \
  --context desktop-linux \
  --image sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48 \
  --binary /absolute/path/to/verified/linux-amd64/llama-swap \
  --output /absolute/path/to/scratch/container-lifecycle.json
```

The image ID above was the already-installed Playwright v1.61.1-noble image;
this script does not pull an image. It requires a pinned image ID, a local Unix
Docker endpoint and the verified Linux amd64 v255 executable digest. The official
archive SHA-256 was
`84aa0df0cf3e302a8591e39de347f64c0c7dce1c3a948df68723a82e1fb4f1d4`;
the extracted executable SHA-256 was
`43e402d6c9f3e6001f5821c3cda35077676cec486a8dcf26d2b780ada01302eb`.

Containers have no network, GPU devices, Docker socket or production data. Each
is limited to one CPU and 384 MiB RAM with a read-only root. Only the script,
contract helper files, binary and synthetic configuration are mounted read-only.
The shared lock/events use a newly-created Docker-native volume, removed along
with the two owned containers afterward. In this Docker Desktop environment a
macOS bind-mounted directory did **not** demonstrate FLOCK exclusion, even between
processes of one container. The native volume passed both same-container and
cross-container probes. Do not treat Mac file sharing as proof of the production
Linux host bind-mount semantics; verify the actual filesystem during the pilot.

## Smallest application integration

Existing `mediaLocalProvider.ts` and `mediaLocalCatalogProvider.ts` already accept
complete configured URLs and validate pinned native results. For a future pilot,
the existing settings can route to:

```text
MEDIA_AI_LOCAL_URL=http://<private-lifecycle-service>/upstream/shield/classify
MEDIA_AI_LOCAL_CATALOG_URL=http://<private-lifecycle-service>/upstream/qwen/catalog
```

These are proposed addresses, not installed configuration. A second HTTP client
or OpenAI-format conversion is unnecessary. Existing auth, redirect rejection,
body limits and response validation should remain. The real servers still need
the residency changes described above.

The current providers collapse errors to `local_failed`; the hybrid worker may
continue to Qwen after a failed classifier call. Consequently, wiring the URL
alone does not implement `waiting_resource` or safe recovery. Application work
must distinguish 429/resource waiting from uncertain execution, avoid counting
waiting as a failure or advancing to another model, and apply results only after
the shared revision/permit authority revalidates them. No endpoint or database
mutation is implemented in this test-only checkpoint.
