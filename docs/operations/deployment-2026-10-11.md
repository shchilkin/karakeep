# Production deployment — 2026-10-11

> Follow-up at 11:34 UTC: after post-deployment verification, autodeploy was
> enabled with future migration/infrastructure approval gates retained. See
> [autodeploy adoption](autodeploy-2026-10-11.md). The deployment-time record below
> describes the state before that separately authorized activation.

**Deployed and verified:** main `c6bd3f15f9597a8429674264c3c0d9014b8ea71e` on homeserver.
At completion (11:20 UTC), production was writable and autodeploy was
**disabled and inactive**; its service was inactive. No rollback was needed.

- Production URL: https://karakeep.shchilkin.dev
- Exact image: `sha256:3fccef9b169b00e12666e6b487c45135d1c4828ee7b814e89b5318b4ab912318`
- Previous image retained: `sha256:1cb9ec1c80d71c8c98cf87361b5b32b244d16c7d0d9c0d8dd95ce78cb572e30f`
- Current container: `98b5f6038c6295c1bc7a9de8e5bea8330d656a0b80532093966c37d2e53333e5`
- Container started: `2026-10-11T11:20:43.327437922Z`
- Release/checkpoint directory: `/srv/appdata/karakeep/manual-rollouts/20261011T111917Z-deploy-c6bd3f15f959`
- Main CI: [38131687586, attempt 2](https://github.com/shchilkin/karakeep/actions/runs/38131687586), all seven checks successful, 161/161 E2E tests.

## Execution

Writers were stopped at 11:19:53 UTC: web (including workers) and Social Enricher.
The idle gate passed before and after stopping. A fresh three-database checkpoint
was completed at 11:19:56 UTC while all these writers were stopped. The earlier
online rehearsal snapshots were not reused as the production rollback checkpoint.

The fresh copy passed migration and verification first. Then the real database
was migrated with the pinned image in an isolated migration process. All 47
non-auth tables / 419059 rows retained their contents; integrity and foreign-key
checks passed. The migration ledger advanced from 105 to 106, with exactly the
expected 0105 hash. One existing user became one credential account; all five
existing API keys were retained.

Before opening writes, checks ran against the real migrated database: first with
no network, then with full workers and no published HTTP port, then through the
public HTTPS address with `DEMO_MODE=true` blocking writes. The public write probe
returned 403. After those checks, the normal production Compose was started with
its original environment and published port; the temporary read-only override
was removed. Social Enricher was resumed. Deployment finished at 11:20:54 UTC.

Only the web image was changed in the persistent Compose configuration. Existing
media, Chrome, Meilisearch and GPU/model services were retained. The deployment
receipt was updated; the old protected-tree approval digest was unchanged at deployment completion.
Autodeploy was not enabled or approved for future protected changes.

## Verification

| Check | Result |
| --- | --- |
| Public health | HTTP 200 |
| Existing production API key | HTTP 200, bookmark read |
| Anonymous bookmark API | HTTP 401 |
| Existing media asset | HTTP 200; byte length matches database |
| Better Auth sign-in/session | HTTP 200 through public HTTPS |
| Wrong password | HTTP 401 |
| Sign-out/session revocation | Passed |
| Worker execution | Temporary text bookmark created (201), indexed and found by search, deleted (204), removed from search |
| Worker process/health | Correct version; HTTP 200; stable s6 process; no fatal worker errors |
| Queue/AI idle gate | Passed after smoke test and after deployment |
| Production container | Healthy, zero container restarts |
| Social Enricher | Healthy |
| Final DB integrity / foreign keys | Passed |
| Temporary data | Test user, credential, API key, sessions and bookmark removed |
| Counts | 1 user, 5 API keys, 15613 bookmarks, 33855 assets |
| Paid media requests | Unchanged at 414; no paid canary was run |
| Test containers | Removed |

Login used a temporary non-admin account with a legacy salted bcrypt credential.
The real owner's credential mapping was verified without obtaining/changing the
owner's password. The owner should sign in again because old sessions were
invalidated by Better Auth. SMTP delivery, third-party OAuth, mobile clients and
paid AI inference were not exercised. Worker execution proof covers a real
create/index/search/delete task; it does not claim every worker workload was run.

## Fresh rollback checkpoint

Private directory on homeserver:
`/srv/appdata/karakeep/manual-rollouts/20261011T111917Z-deploy-c6bd3f15f959/backup`

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `db.db` | 239980544 | `7bb21bdb785481d593b0525242b3e0462e934268577b9505c4164d2bc1ee6405` |
| `queue.db` | 98304 | `ec03b6dfe3b4e4c380585c60c75775d07d7d3a8bfb789abf27975e39f067500a` |
| `social-enricher.sqlite3` | 106496 | `8c9a2b4576d8058d30b357ab17149de01e0075f73d7c24f8c45fe9abce02e917` |

All three backups passed integrity checks and final checksum verification. Their
original UID/GID/mode and resolved source paths are recorded in `checkpoint.json`
on homeserver. The parent directory is mode 0700; backups/configuration are private.
The deployment script, detailed logs and receipts are retained in that release
directory. Database/configuration contents were not copied to the workstation.

Use the [manual rollback runbook](README.md#coordinated-rollback), with the
release-specific details in the [preparation record](manual-rollout-2026-10-11.md),
**this fresh checkpoint** and the previous image. Because public writes are
now open, any later rollback must first freeze writers and preserve/reconcile
changes made after this checkpoint. Merely reverting the image is not compatible
with the migrated auth schema. Assets were not snapshotted or deleted.

See [aggregate evidence](deployment-result-2026-10-11.json) for exact values and
timestamps. The reports and verifier were prepared in the dedicated
`codex/karakeep-manual-rollout` worktree.
