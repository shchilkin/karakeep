# Private CUDA classifier

Build from this directory. The service expects an already downloaded model at
`/models`, including `download-manifest.json` with the pinned `model` and `revision`
listed in `server.py`. The manifest identifies the snapshot; it is not a runtime
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
docker build -t karakeep-sensitive-classifier:review .
python -m unittest test_policy.py
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
