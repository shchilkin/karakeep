# Homeserver automatic deployment

The public fork runs CI on GitHub-hosted runners. A fixed controller installed on
homeserver checks `main` every five minutes using GitHub's public API. It deploys
only an exact main SHA with a completed, successful **push** run of `ci.yml` from
this repository. PR runs, other branches/workflows/repositories, failed reruns,
and revisions superseded during the build cannot deploy. No incoming port,
webhook, GitHub token or public-repository self-hosted runner is needed. The
existing private Social Enricher runner is independent.

`poll.py` is installed on the host, not loaded from an untrusted workflow or
artifact. It fetches only the fixed repository's main branch. Repository write
access remains trusted production-code access. The application builds from the
exact SHA, uses an immutable image tag and is tested against a SQLite snapshot
with read-only media, no network, no cloud credentials and disabled workers.
Health, authenticated API access, anonymous denial and unchanged migration
history must pass before cutover. Source/build logs and database/config backups
stay under `/srv/appdata/karakeep/autodeploy`, mode 700/600.

A host lock serializes deployments. Active media/AI work defers cutover. Only the
web container is replaced; the Social Enricher pauses briefly and resumes. The
controller backs up both SQLite databases using SQLite's backup API and checks
them. Existing media stays in place and is not copied or rewritten. On failed
health verification it starts the exact previous image ID, retaining the current
database so new saves are not lost. This automatic rollback does not undo data
migrations: changes under `packages/db/drizzle/`, `packages/db/migrate.ts`, `docker/` or `deploy/` pause for
a manual rollout and approval of a new protected-tree digest. Model changes,
new infrastructure, controller changes and schema changes therefore cannot be
silently activated by the timer. AI configuration and model services remain as
last explicitly deployed. No backfill or paid canary runs automatically.

A failed revision is recorded once as `failed-<sha>` and is not retried every five
minutes. Inspect the private logs and `status.json`, then remove that marker only
when ready for a deliberate retry. CI/queue waits are harmless and retry on the
next timer tick. An interrupted cutover (power loss/SIGKILL) may require manual
recovery from the release backup. Retention/pruning is manual.

## Install after a verified manual rollout

Copy the reviewed `poll.py` to
`/srv/appdata/karakeep/autodeploy/poll.py` and the service/timer files to
`~/.config/systemd/user/`. Use owner UID, mode 700 for the state directory and
600 for files. Initialize the controller's public bare cache and record the
protected tree of the exact deployed commit:

```python
# Run in the installed controller's directory, on homeserver.
import json
import poll
sha = "<verified deployed full SHA>"
poll.fetch_main(sha)
(poll.STATE / "approved-protected-tree").write_text(poll.protected_digest(sha) + "\n")
# Adopt only after checking that the live image revision really matches sha.
live = poll.inspect(poll.WEB)
assert live['Config']['Labels']['org.opencontainers.image.revision'] == sha
(poll.STATE / "deployed.json").write_text(json.dumps({'sha': sha, 'imageId': live['Image']}))
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now karakeep-fork-autodeploy.timer
systemctl --user start karakeep-fork-autodeploy.service
systemctl --user list-timers karakeep-fork-autodeploy.timer
```

User lingering must already be enabled for operation after SSH logout/reboot.
Pause with `systemctl --user stop karakeep-fork-autodeploy.timer`; this does not
interrupt an in-flight deployment. Check the service before manual operations.
Do not approve a new protected-tree digest solely to dismiss a guard failure.

References: GitHub [workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
and [secure workflow use](https://docs.github.com/en/actions/reference/security/secure-use).
