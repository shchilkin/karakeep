# Production verification and autodeploy adoption — 2026-10-11

Autodeploy was enabled at **11:34:01 UTC** after checking the manually deployed
main revision `c6bd3f15f9597a8429674264c3c0d9014b8ea71e` on homeserver.
The production container, image and start timestamp remained unchanged.

- Production: https://karakeep.shchilkin.dev
- Image: `sha256:3fccef9b169b00e12666e6b487c45135d1c4828ee7b814e89b5318b4ab912318`
- Container: `98b5f6038c6295c1bc7a9de8e5bea8330d656a0b80532093966c37d2e53333e5`
- Started: `2026-10-11T11:20:43.327437922Z`; zero restarts throughout verification.
- CI: [38131687586, attempt 2](https://github.com/shchilkin/karakeep/actions/runs/38131687586), completed successfully for this exact main SHA.
- Adoption record and prior controller state:
  `/srv/appdata/karakeep/autodeploy/adoptions/20261011T113400Z-c6bd3f15f959`

## Production checks

Checks ran approximately 11–13 minutes after the production switch, before and
after enabling the timer. This is a post-deployment smoke check, not a long soak.

| Check | Result |
| --- | --- |
| Public HTTPS health / sign-in page | HTTP 200 / 200 |
| Existing API key / anonymous bookmark read | Accepted / denied (401) |
| Web / Social Enricher | Healthy; zero restarts |
| Worker health | HTTP 200, `status: ok` |
| Worker process | Same PID 84, running continuously since deployment |
| Fatal worker/database log patterns since startup | Zero matches |
| Main, queue and Social Enricher SQLite integrity | All `ok` |
| Foreign-key violations | Zero in all three databases |
| Migration ledger | 106 entries |
| Users / credential accounts / API keys | 1 / 1 / 5 |
| Bookmarks / assets | 15613 / 33855 |
| Paid media requests / runs | Unchanged at 414 / 4137 |
| Durable queue tasks / active Social Enricher jobs | 0 / 0 |
| Controller idle gate | Passed before and after activation |
| Meilisearch / Chrome | Running, unchanged containers and zero restarts |

This follow-up did not create a new login fixture. Actual Better Auth
sign-in/session/sign-out and a real worker create/index/search/delete task were
verified during the [manual deployment](deployment-2026-10-11.md). The owner's
password was not obtained or changed. No paid AI work was started.

## Autodeploy and manual approval boundary

The existing installed controller and systemd unit files were retained byte for
byte. Under the deployment lock, the exact protected tree of the verified live
revision was adopted. The deployment receipt, previous image reference and cold
rollback checkpoint were preserved byte for byte.

Approved digest:
`6fdd2957a998a775851ebab24df26e0ffca044e0238909f54e11133f808a80bd`

At verification, the timer was **enabled, active and waiting**. It checks approximately every five
minutes, with up to 15 seconds of randomized delay. User lingering is enabled,
so it continues after SSH logout and system reboot. Its first actual systemd run
finished successfully at 11:34:01 UTC. Because main was already deployed, it
performed no build or replacement; production was not restarted.

Future changes to these paths retain the `manual_rollout_required` gate:

- `packages/db/drizzle/` — database migration files and metadata;
- `packages/db/migrate.ts` — migration runner;
- `docker/` — image and Docker infrastructure;
- `deploy/` — deployment infrastructure and controller source.

No automatic approval of future protected digests was added. Host environment,
Compose configuration, model services and installed controller upgrades remain
manual. A future protected change requires an explicitly authorized manual
rollout, migration rehearsal/backup as applicable, and adoption of its exact
verified digest. Do not advance the digest just to clear a blocked deployment.

Other application commits still require green CI for the exact main push,
unchanged protected paths, drained work queues, an isolated snapshot canary with
unchanged migration history, and live health/API checks. Existing backup and
same-schema image rollback behavior remains in place.

## Guard verification

The installed controller matches the repository copy (SHA-256
`45dc282783d7b279152fe4a26aaa98f34e990993e098d8d565f9d1c9e0e200b0`).
Its actual digest and poll logic were exercised with a temporary Git repository
and mocked deployment actions. A separate change in each of the four protected
paths emitted `manual_rollout_required` before idle/build/canary/cutover. An
ordinary `apps/web/` change left the protected digest unchanged. No production
files or Git refs were changed by these tests.

All **16 controller unit tests passed**. Python 3.14 emitted ResourceWarnings
about unclosed SQLite connections in the existing test/controller code; there
were no test failures. No controller code was changed in this operation.

## Records and pausing

See [machine-readable adoption evidence](autodeploy-adoption-2026-10-11.json).
The prior guard, status and deployment receipt are saved privately in the adoption
directory on homeserver. The existing cold deployment checkpoint remains at:
`/srv/appdata/karakeep/manual-rollouts/20261011T111917Z-deploy-c6bd3f15f959/backup`.

To pause future polls, run on homeserver:

```sh
systemctl --user disable --now karakeep-fork-autodeploy.timer
systemctl --user status karakeep-fork-autodeploy.service
```

Disabling the timer does not interrupt an already running deployment. Check the
service before any manual rollout. A later rollback to the pre-Better-Auth image
still requires coordinated database rollback and reconciliation of newer writes,
as described in the [manual rollback runbook](README.md#coordinated-rollback).
