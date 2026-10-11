# Homeserver operations

These runbooks cover manual production migrations, rollback and adoption of a
verified release by the [installed autodeploy controller](../../deploy/homeserver/README.md).
They do not grant permission to execute a production change.

## Recorded rollout: 2026-10-11

| Stage | Record | Evidence |
| --- | --- | --- |
| Better Auth rehearsal and rollback preparation | [Preparation](manual-rollout-2026-10-11.md) | [Preparation results](preparation-summary-2026-10-11.json) |
| Production migration and cutover | [Deployment](deployment-2026-10-11.md) | [Deployment results](deployment-result-2026-10-11.json) |
| Post-deployment verification and timer activation | [Autodeploy adoption](autodeploy-2026-10-11.md) | [Adoption receipt](autodeploy-adoption-2026-10-11.json) |

At the end of this sequence, production ran main
`c6bd3f15f9597a8429674264c3c0d9014b8ea71e` and autodeploy was enabled.
The preparation and deployment records describe earlier points in that sequence;
their disabled-timer states are historical. Recheck the live revision, timer and
database state before another operation. Old image IDs, paths and counts are
evidence for that release, not defaults for a new rollout.

Only reports, aggregate results and a read-only verifier belong in this directory.
Keep databases, environment files, API keys, password hashes, session responses,
raw logs and private configuration on homeserver with restricted permissions.

## Approval boundary

Ordinary application commits can deploy only from the exact main revision with
successful main-push CI, a matching protected-tree digest, idle queues, a passing
isolated canary and live checks. The installed controller blocks changes under:

- `packages/db/drizzle/` and `packages/db/migrate.ts`;
- `docker/` and `deploy/`.

Database migrations, infrastructure changes and installed controller upgrades
require explicit manual approval. A green CI run or merge does not approve them.
Never advance `approved-protected-tree` simply to clear `manual_rollout_required`.
Host configuration and model services are updated only through a separately
reviewed manual operation.

## Prepare a future migration

1. Record the exact candidate SHA and successful latest main CI, live revision,
   image IDs, Compose project, resolved data mounts and running writers. Review
   the migration and its compatibility with the old image. Pin both candidate
   and rollback image IDs and check available disk space.
2. Create private online SQLite Backup API snapshots for rehearsal. Record
   hashes, integrity, foreign keys, schema/migration history and relevant counts.
   Rehearsal snapshots do not replace the final checkpoint taken with writers
   stopped. Plan separate media/search snapshots if the proposed change can
   modify those stores; a DB-only checkpoint is not disaster recovery.
3. Migrate a copy with the exact candidate image. Isolate it from production
   mounts and network services; disable workers and paid inference, publish no
   ports and mount any necessary media read-only. Check expected schema/data
   changes, retained data, auth/API behavior and repeated migration invocation.
4. Rehearse restore of the old-schema checkpoint with the pinned old image on an
   isolated copy. Record any feature-specific rollback limits and the acceptance
   criteria for opening writes. Obtain approval for the concrete production plan.

For migration 0105 only, [verify-better-auth-copy.py](verify-better-auth-copy.py)
compares pristine and migrated SQLite files without printing row values:

```sh
python3 verify-better-auth-copy.py BEFORE_DB AFTER_DB SOURCE_DRIZZLE_DIR
```

Run with normal Python assertions enabled (no `-O` or `PYTHONOPTIMIZE`). Both
databases must be stable snapshots with no concurrent writers. The source folder
must come from the exact candidate revision. This helper checks the specific
0105 mapping; adapt and review verification for each future migration. It is not
a migration runner or a general schema compatibility test.

## Authorized maintenance window

1. Pause admission/import coordinators and drain all durable queues, delayed
   tasks, AI work and Social Enricher jobs using the installed `idle()` gate.
   Do not kill active work or clear queue rows to satisfy the gate.
2. On homeserver, disable the timer and inspect its service:

   ```sh
   systemctl --user disable --now karakeep-fork-autodeploy.timer
   systemctl --user show karakeep-fork-autodeploy.service --property=ActiveState --property=Result
   ```

   Disabling the timer does not stop an in-flight deployment. Wait for the service
   to become inactive. Hold `/srv/appdata/karakeep/.fork-deploy.lock` exclusively
   through backup, migration, verification and final deployment-state recording.
3. Stop every production writer, including web and its workers, Social Enricher
   and external coordinators. Verify their stopped state and recheck idle queues.
   Keep public writes unavailable until acceptance; application read-only mode
   alone does not stop background writers.
4. Take a fresh, timestamped checkpoint of `db.db`, `queue.db` and Social Enricher
   state while all writers remain stopped. Include original Compose/env,
   controller receipt/guard, image IDs, resolved file paths and UID/GID/mode.
   Validate integrity and hashes; use private 0700 directories and 0600 backup
   files. Preserve symlinks and restore through their resolved target paths.
5. Rehearse migration on a new copy of this final checkpoint. If it fails, resume
   the unchanged old stack. If it passes, migrate the real database using the
   same pinned image, reviewed migration entry point and resolved mount, with
   no workers or network access. Compare the result with the checkpoint.
6. Verify isolated web health, existing API access, anonymous denial, assets and
   authentication. Then test workers and search with a bounded disposable task
   while public writes remain blocked. Avoid paid calls; remove test data and
   wait for queues to drain. Rehearse any maintenance/read-only override and
   positively verify that it blocks public mutations.
7. Change only the intended service/image/configuration, validate Compose, and
   run the final public health/login/API checks while writes are blocked. On a
   failed check, use the coordinated rollback below. On success, restore the
   normal environment, open writes and resume only previously active services.
   Check image identity, worker health, queues, logs and database integrity again.
8. Record the deployed SHA, immutable image ID, previous image and fresh backup
   path. Preserve this receipt for rollback. Keep the timer paused until release
   acceptance and explicit authorization to resume autodeploy.

## Coordinated rollback

Do not use the controller's ordinary `cutover()` for a schema-changing rollout:
its automatic rollback retains the current database. An old image must be paired
with a compatible old-schema checkpoint unless compatibility was proven.

Before restoring:

1. Keep the timer paused and acquire/retain the deployment lock. Stop and verify
   all writers, including temporary checks, workers and external coordinators.
2. Preserve the failed DBs, queues, sidecar state and associated WAL/SHM/journal
   files, along with image/config receipts and diagnostic logs, in a separate
   private directory. Never discard this evidence or media to make restore easy.
3. If public writes or background work occurred after the checkpoint, measure
   and reconcile/export the delta before restoring, or obtain explicit approval
   for the measured data loss. Do not blindly restore an old checkpoint over new
   saves. Include queue, media and search effects in the reconciliation plan.
4. Restore all coordinated SQLite files from the final checkpoint using temporary
   sibling files and rename into their resolved paths. Restore recorded ownership
   and permissions; preserve symlinks. Remove stale WAL/SHM/journal files from the
   restored locations only after preserving them with the failed state.
5. Check restored hashes, integrity, foreign keys, expected old migration ledger
   and counts before any process starts. Restore reviewed configuration as needed
   and start the pinned old image. Verify health, auth, API and workers, then
   resume only services that were previously running. Reconcile/reindex search
   if post-cutover work changed it; retain the production assets.
6. Restore the controller receipt and approved digest consistently with the
   actual restored revision. Keep autodeploy disabled until the failed candidate
   is handled; restoring metadata alone must never permit an immediate retry.

## Resume autodeploy after acceptance

1. Recheck the live image label/ID against the accepted main SHA, successful latest
   CI, production checks, the installed controller and unchanged unit files.
2. With the timer disabled and service inactive, hold the deployment lock. Back
   up `deployed.json`, `status.json` and `approved-protected-tree` privately.
   Fetch the exact main into the controller cache; verify `FETCH_HEAD` still
   matches. Calculate the digest using the installed `protected_digest()`.
3. Approve only that reviewed digest. Ensure the deployment receipt matches the
   live revision while preserving its previous-image and backup fields. Use
   atomic file replacement; keep the timer disabled if adoption is incomplete.
   Do not implicitly install a changed controller or approve future digests.
4. Release the lock before starting the controller, which acquires it itself:

   ```sh
   systemctl --user enable --now karakeep-fork-autodeploy.timer
   systemctl --user start karakeep-fork-autodeploy.service
   systemctl --user list-timers karakeep-fork-autodeploy.timer
   ```

5. Confirm the timer is enabled/active, user lingering is enabled and the service
   completed successfully. With main already recorded as deployed, the poll must
   leave the container ID, image and start time unchanged. Recheck public health
   and API; retain evidence of the adoption and the previous metadata.
