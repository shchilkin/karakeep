# Manual rollout preparation — main c6bd3f15

Prepared on 2026-10-11. Production was unchanged during this preparation.

**Subsequent events on 2026-10-11:** the [production deployment](deployment-2026-10-11.md) completed, then [autodeploy was enabled](autodeploy-2026-10-11.md) after separate verification and approval. This document retains the preparation-time plan and evidence. For future operations, use the [manual migration and rollback runbook](README.md).

Target: `c6bd3f15f9597a8429674264c3c0d9014b8ea71e` ([PR #30](https://github.com/shchilkin/karakeep/pull/30)).
Preparation branch: `codex/karakeep-manual-rollout`.

## Private artifacts on homeserver

```text
/srv/appdata/karakeep/manual-rollouts/20261011T103102Z-c6bd3f15f959/
  manifest.json                  backup receipts and original production identity
  backup/db.db                   pristine pre-Better-Auth SQLite backup
  backup/queue.db                 queue backup
  backup/social-enricher.sqlite3  sidecar state backup
  config/                        Compose, environment files, controller state/guard
  source/                        git archive of the exact target SHA
  candidate-data/                 migrated copy; no production mounts
  runtime-candidate/              separate copy used for HTTP checks
  auth-fixture/                   separate copy with synthetic legacy users
  rollback-rehearsal/             restored old-schema copy
  logs/                          build, migration and isolated web logs
  rehearsal.json                 detailed verification results
  preparation-summary.json       aggregate final evidence
  verify-better-auth-copy.py      read-only structural/data verifier
  rehearse-better-auth.py         scenario used for this rehearsal
```

The containing directory is mode 0700; database, configuration and evidence files
are private. Do not publish the config, database, raw auth responses or web logs.
No database or production secrets were downloaded to the workstation.

| Database | Bytes | SHA-256 | Integrity |
| --- | ---: | --- | --- |
| `db.db` | 239980544 | `300ee4d7362df4737543428e9a96564ed3321d0cd8a74b3e883c646af19e9a28` | ok |
| `queue.db` | 98304 | `ec03b6dfe3b4e4c380585c60c75775d07d7d3a8bfb789abf27975e39f067500a` | ok |
| `social-enricher.sqlite3` | 106496 | `8c9a2b4576d8058d30b357ab17149de01e0075f73d7c24f8c45fe9abce02e917` | ok |

These are individually consistent online SQLite Backup API snapshots, created
while production continued serving traffic. They are a rehearsal baseline, **not
the final quiesced checkpoint for a later deployment**. Assets and Meilisearch
were not copied; this is database/configuration rollback preparation, not an
off-host disaster-recovery backup. Neither assets nor search indexes were changed
by the rehearsal.

The apparent database paths under `/srv/storage/karakeep-data` are symlinks.
Actual production files are:

- `/home/shchilkin/.local/share/karakeep/data/db.db`
- `/home/shchilkin/.local/share/karakeep/data/queue.db`
- `/srv/appdata/karakeep/social-enricher/state/jobs.sqlite3`

Keep the symlinks intact when restoring. Production media is mounted separately
from `/srv/storage/karakeep-data/assets`.

## Images and evidence

Candidate tag: `karakeep-fork:prepared-c6bd3f15f959`.
Exact candidate image ID:
`sha256:3fccef9b169b00e12666e6b487c45135d1c4828ee7b814e89b5318b4ab912318`
(`linux/amd64`).
Rollback tag: `karakeep-fork:rollback-20261011T103102Z-1cb9ec1c80d7`.
Exact old image ID:
`sha256:1cb9ec1c80d71c8c98cf87361b5b32b244d16c7d0d9c0d8dd95ce78cb572e30f`.
Old revision: `9f1f4042b0dbe4713f5f96d795d62bb65f57c3cb`.

The candidate is built from the exact main archive with Docker target `aio`,
`SERVER_VERSION=c6bd3f15f959`, and an OCI revision label containing the full SHA.
Retain both image IDs; do not prune them before the rollout/rollback window ends.

Rehearsal completed at **2026-10-11 10:42:51 UTC**:

| Check | Result |
| --- | --- |
| Migration 0105 in actual candidate image | Passed in 3.27 s; ledger 105 → 106 |
| Integrity and foreign keys before/after | Passed |
| Unchanged non-auth data | All 47 tables / 419059 rows match by content hashes |
| Real legacy user/credential conversion | 1 user / 1 credential; fields and hash mapping checked |
| Existing API keys | All 5 rows preserved; existing sidecar key HTTP 200 |
| Second migration invocation | Full logical data/schema unchanged |
| Queue snapshot | Byte hash unchanged |
| Candidate HTTP | Health 200; authenticated bookmark read 200; anonymous 401 |
| Salted and unsalted legacy fixtures | Login/session 200; bad password 401; signout and revocation passed |
| Rollback rehearsal | Migrated test DB replaced by pristine checkpoint; hashes match; old image health/API pass; ledger 105 |
| Isolation | No network, no published ports, no production mounts, web only, no workers |
| Cleanup | All three disposable web containers removed |
| Production postcheck | Same container ID/image/start time; healthy; Compose/env/controller state unchanged |
| Installed idle gate | Passed at preparation time; must be checked again at cutover |

The original three backups still match their recorded SHA-256 values. All four
resulting test databases passed a final integrity check. The Social Enricher
backup was integrity-checked; its container was not started/restored in this
rehearsal. The rollback HTTP proof covers the core web database and queue. Detailed
aggregate evidence is in `preparation-summary-2026-10-11.json` beside this document
and in the private remote `rehearsal.json`/`preparation-summary.json` files.

**Final CI: success, attempt 2, all seven checks passed.**
CI for this exact main:
[run 38131687586](https://github.com/shchilkin/karakeep/actions/runs/38131687586).
Attempt 1 passed 160/161 E2E tests; the S3 large-asset test timed out after 60 s.
Attempt 2 passed all **161/161 E2E tests across 23 files**, including the S3
asset suite, without changing the code. The initial timeout did not reproduce;
its underlying cause was not established. The exact main must have a successful
latest CI attempt before cutover; that condition is satisfied at preparation time.

## What changes during migration

Migration `0105_migrate_to_better_auth` moves each legacy password into a
credential account, preserving the bcrypt hash and salt. It changes
`emailVerified` from a timestamp to a boolean, adds user timestamps, and normalizes
non-conflicting email addresses. It recreates sessions and verification tokens
empty and drops the legacy password-reset table. Users need to log in again;
old password-reset/verification links must be requested again.

This production snapshot contains one user, five API keys and no OAuth accounts.
Real password conversion is checked without knowing or displaying the password;
actual HTTP login is tested with synthetic salted and unsalted legacy users in
another copy. There is no claim of testing the owner's password, external OAuth,
SMTP delivery, public proxy routing, mobile clients or media/AI workers here.

## Historical rollout plan — required separate production authorization

The following is the plan written before the 2026-10-11 deployment. It is not an
execution log or permission to rerun that migration; the linked execution report
records the final staged verification and cutover sequence.

1. Reconfirm the exact main SHA, successful latest main CI, both local image IDs,
   available disk space, live Compose/mounts and that production is still on the
   recorded old revision. If main or live state changed, refresh this preparation.
2. Announce a short maintenance window. Pause external import coordinators and
   admission of new work. Drain all durable queue tasks, delayed jobs, AI work,
   imports and Social Enricher work using the installed controller's `idle()`
   checks. Do not kill active jobs to pass the gate.
3. Stop `karakeep-fork-autodeploy.timer`; ensure its service is inactive, then hold
   `/srv/appdata/karakeep/.fork-deploy.lock` exclusively for the whole operation.
   A stopped timer does not stop an already running service. Never call the
   installed `poll.cutover()` for this schema transition: its automatic rollback
   deliberately retains the current database.
4. Record running service/container identities and pause all writers, including
   `karakeep-social-enricher-social-enricher-1` and `karakeep-web-1` (the latter
   includes workers). Verify no external coordinator still holds/writes the DBs;
   rerun the idle check after stopping. Public writes stay unavailable until the
   final acceptance step.
5. Create a **new**, timestamped checkpoint after quiescence: all three SQLite
   databases via SQLite Backup API, integrity checks, SHA-256 receipts, file
   UID/GID/mode, the current Compose/env files, image IDs, controller state and
   approved guard. Keep this checkpoint and failed-state captures private.
   All writers must stay paused, making the three snapshots one stable checkpoint.
6. First rehearse migration on a fresh copy of that checkpoint using the already
   tested image ID. Run `verify-better-auth-copy.py BEFORE AFTER SOURCE_DRIZZLE_DIR`.
   Check integrity/foreign keys, migration history, unchanged non-auth rows and
   legacy account mapping. Abort and resume the unchanged old stack on failure.
7. Migrate the real DB only inside that maintenance window, using the same image
   ID, `/db_migrations/index.js`, `/db_migrations` working directory, `DATA_DIR=/data`,
   `--network none`, and the **resolved** real data mount. Never start workers as
   part of this migration command. Compare against the fresh checkpoint again.
8. Before opening production, run only the web entry point
   `node /app/apps/web/server.js` against the migrated data in a temporary
   `--network none` container with no published ports and no workers. Verify health,
   authenticated bookmark reads with the existing key, anonymous denial and the
   106-entry ledger. Pass credentials through stdin/private files, never argv/logs.
   Use read-only media if checking an asset. Stop this temporary process before
   starting the regular service. On any failure, use the rollback below while
   writes remain closed.
9. Update only `services.web.image` in the production Compose to the tested
   candidate image ID (the installed `replacement()` helper can produce this
   edit), save the old Compose, and validate with `docker compose config --quiet`.
   Only after the maintenance checks pass, start web with the existing project:
   `docker compose -f /srv/appdata/karakeep/compose.yaml up -d --no-deps --no-build --pull never web`.
   This step starts the normal workers and reopens public writes. Verify exact
   image ID, `/api/health`, API access, assets, manual browser login and worker logs.
   Resume previously running Social Enricher/import coordinators deliberately.
10. Record the deployed revision, image and checkpoint. Leave autodeploy paused
    until manual acceptance and a separate decision to adopt this protected tree.
    Adoption must update `deployed.json` and the reviewed protected-tree digest
    together after verifying the live image; never change the guard merely to
    bypass the migration requirement. Do not install a new controller implicitly.

## Rollback plan

**The old image must be paired with the old-schema database checkpoint.** Switching
only the image after 0105 is not a valid rollback; this migration has no automatic
SQL down migration.

Before public writes/workers are reopened:

1. Keep the timer/importers paused and the deployment lock held. Stop every
   process using the migrated data, including the temporary web check, regular
   web/workers if started, and Social Enricher. Verify the containers are stopped.
2. Preserve the failed state in a separate private timestamped directory:
   `db.db`, `queue.db`, `jobs.sqlite3` and any associated `-wal`, `-shm`, `-journal`
   files, plus logs and image/Compose receipts. Do this only after writers close.
   Preserve files by moving/copying them; do not delete the evidence.
3. Restore **all three** databases from the final pre-cutover checkpoint to their
   resolved paths. Copy via temporary sibling files and rename into place; restore
   recorded UID/GID/mode. Ensure no stale WAL/SHM/journal from the migrated database
   remains beside a restored file. Never replace the `/srv/storage` symlinks.
4. Verify the restored hashes, `PRAGMA integrity_check`, foreign keys, 105 migration
   entries and baseline row counts before starting any process. Restore original
   Compose/env only if changed, and select the pinned old image ID above.
5. Start only web using Compose `--no-deps --no-build --pull never`. Verify the
   old image ID, health, existing API key, anonymous denial and old login. Resume
   only services that were previously running. Keep the autodeploy guard/state
   at the old revision and the timer paused until the failed candidate is handled.
   Keep existing assets and Meilisearch; no migration test altered them.

If public saves or background work were accepted after cutover, first freeze
writes again and retain the new DBs, queues and media. Restoring a pre-cutover
snapshot would discard those writes. Reconcile/export that delta or explicitly
accept the measured loss before restoring; no unattended rollback is safe in
that state. Do not run the old application against the migrated database as a
shortcut. Search may need reconciliation/reindexing if post-cutover workers ran;
never purge the production asset directory as part of rollback.

## Autodeploy guard at preparation time

Approved old protected-tree digest:
`f9a9b02123fd7a827a2a27d0653e2e263495add5c3c408b90fa82cd26a3d6872`.
Target protected-tree digest:
`6fdd2957a998a775851ebab24df26e0ffca044e0238909f54e11133f808a80bd`.
They differ. The installed controller checks this before build/cutover after CI;
preparation does not modify that guard or `deployed.json`.
