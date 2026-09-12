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
   limits. Test Jellyfin playback/coexistence separately. These results do not
   establish GPU capacity, Linux/Docker behavior or production readiness.

Reference configuration: [v255 config example](https://github.com/mostlygeek/llama-swap/blob/v255/docs/config.example.yaml).
