# Hybrid CI: hosted checks + isolated ARC E2E

The `CI` workflow keeps lint, formatting, typecheck, unit/contract tests and OpenAPI
checks on GitHub-hosted Linux. Docker E2E for repository-owned code uses the
repository-scoped `arc-karakeep-e2e` scale set. External-fork and Dependabot PRs use
hosted E2E instead. The `tests` aggregate requires **both** suites to succeed;
skipped/cancelled suites are not accepted. There is no automatic hosted failover
for a missing ARC runner: inspect ARC availability rather than silently rerunning.

This is not a production deployment or a GPU job. Karakeep E2E uses its own web,
worker, headless Chrome, Meili, MinIO and AIMock containers with synthetic data and
fixture-only AI. No mymind, live account, paid AI, production volume, GPU endpoint,
host Docker socket or private-network access is supplied.

## Runner boundary

- Existing isolated `arc-ci` VM: 5 vCPU / 16 GiB. Do not increase host allocation.
- Namespace `arc-karakeep`, release/label `arc-karakeep-e2e`, chart 0.14.2.
- Zero idle runners, at most one job. Pod requests 3750m CPU / 9 GiB RAM; combined
  limits 4 CPU / 11 GiB. Heavy E2E waits for other pools to drain rather than
  overcommitting admission (4500m node allocatable, 650m control/other requests at
  installation). Recheck capacity before adding more pools.
- Ephemeral work (20 GiB), Docker data (30 GiB), tool cache (3 GiB); no host mounts.
  Docker is a privileged sidecar **inside the CI VM**, not the homeserver daemon.
- Apply `runner-network-policy.yaml` before creating runner pods. It denies ingress
  and private/loopback/VPN/IPv6 egress except cluster DNS. Keep the VM outbound guard.
- No Kubernetes service-account token in job pods. The existing controller reads
  `github-auth`; never store its token in Git, Helm values, logs or job secrets.
- Repository Actions setting must require approval for **all external contributors**.
  Workflow guards alone are not a security boundary because a PR can edit them.
  Review every external workflow change before approving a run; approval grants
  execution, not merely access to a hosted check. Keep token permissions read-only.

## Installation / rollback

From the management SSH connection, verify the existing controller, chart, pinned
runner image and free capacity. Provision `arc-karakeep/github-auth` through the
existing private credential mechanism, after verifying Karakeep access. Never put
the credential on a command line or export it to the workstation.

```sh
sudo kubectl create namespace arc-karakeep
sudo kubectl apply -f runner-network-policy.yaml
sudo env KUBECONFIG=/etc/rancher/k3s/k3s.yaml helm upgrade --install \
  arc-karakeep-e2e /home/ci-admin/arc-setup/gha-runner-scale-set-0.14.2.tgz \
  -n arc-karakeep -f arc-karakeep-values.yaml --wait --timeout 120s
sudo kubectl get autoscalingrunnersets -n arc-karakeep
sudo kubectl get pods -n arc-system
```

Listener readiness is not E2E proof. Verify a real Actions job on this label and its
final result, Docker cleanup and zero remaining runner pods. On failure preserve
the run URL and diagnostics; do not turn a failing suite into a skipped check.

To roll back, route E2E to `ubuntu-latest`, let jobs drain, then uninstall **only**
`arc-karakeep-e2e` from `arc-karakeep`. Keep other pools, the shared controller, VM
and network guards untouched. Do not delete shared credentials or production data.

## MinIO fixture

The previously pinned Quay release and Docker Hub tag both failed to resolve on
2026-09-25, before any E2E tests ran. MinIO's official repository now distributes
source rather than maintained release binaries. `setup/minio/Dockerfile` builds
the same release from official commit `07c3a429bfed433e49018cb0f78a52145d4bedeb`;
the source archive SHA256 and builder/runtime image digests are pinned. The fixture
runs non-root, with its license retained. This old test release is **not** a
recommendation for a production object store.

Compose builds are serialized to bound memory. A workflow-level `always()` cleanup
uses the unique per-run Compose project even if Vitest global setup fails; logs are
retained for seven days. The ephemeral runner also removes Docker state after the
job, including interruption/timeout. No cross-repository mutable Docker cache is
mounted.
