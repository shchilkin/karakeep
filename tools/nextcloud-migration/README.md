# Bounded Nextcloud migration client

Server-only source adapter for the `deferred-copy-v1` foundation API. It preserves
the known exported blob set and its metadata with a durable, resumable client
journal. It does not claim that the upstream mymind export was complete.

This directory changes no Karakeep schema, endpoint, worker or shared policy.
The foundation owns source identity, duplicate resolution, storage commits,
fencing and persistent deferred processing. This client requires the foundation
to advertise `materialize=true` and `persistentDeferred=true` before reading any
source bytes. It has no AI invocation, processing release, cleanup or delete command.

## Boundaries and behavior

- `seed` reads existing server audit JSONL and read-only `sync.db`; it never
  enumerates mymind or rescans Nextcloud. The original metadata stays verbatim in
  its staged document. Missing URLs, notes, collections and carousel completeness
  stay unknown/not exported. Two divergent current revisions and the four
  preserved recovery revisions are held, not resolved by a preferred hash.
- Source staging checks path, file ID, strong ETag and size with depth-zero
  PROPFIND, uses GET with If-Match, hashes actual bytes, fsyncs a partial file,
  atomically promotes it, then rereads it. Resume revalidates existing staged
  bytes. MIME comes from bytes; files are never transcoded or relabelled in place.
- Copy only: source lookup precedes upload. Equal content from another source
  does not authorize asset reuse or metadata overwrite. Stable reservation keys
  and payload digests are journaled before requests. A lost commit response is
  recovered through status/receipt, without a second materialization.
- Each run selects at most 12 items and 256 MiB, defaults to one item and 50 MiB
  through the CLI. Source streaming is sequential at up to 16 MiB/s with a 40 GiB
  disk reserve; target writes are spaced at least three seconds across resume.
  Any failure stops the chunk. Retryable transport errors retain retry state;
  conflicts and mismatches stay held. No implicit retry loop runs.
- The client currently permits JPEG, PNG, WebP, GIF and PDF, within the server's
  stricter advertised limits and a 50 MiB client cap. Videos, unsupported binary
  content and larger objects stay outside this pilot even though they belong in
  the backup. Header sniffing is not full decoding; the foundation verifies its
  own staged bytes and accepted formats.
- Verification downloads the complete target original and raw metadata and
  checks the bookmark's title, note, tags, source URL, asset and saved timestamp.
  The existing bookmark SQL column projects time to whole seconds; the exact
  original fractional timestamp remains in raw metadata and the immutable payload.
  `reconcile` repeats bounded source PROPFIND/target GET checks for committed
  records, rotating by last check. It does not clear holds or reupload files.

## Private server configuration

Python 3.9+ standard library is sufficient for the client. Production commands
require Linux and the configured exact hostname. Keep configuration and token
files mode 0600, directories 0700. No credentials, full manifests, source IDs,
media paths or real media belong in this repository or on the Mac.

```json
{
  "expectedHostname": "YOUR_SERVER_HOSTNAME",
  "accountScope": "YOUR_STABLE_OWNER_SCOPE",
  "stateDirectory": "/private/server/path/client-state",
  "auditDirectory": "/private/server/path/frozen-audit",
  "syncDatabase": "/private/server/path/sync.db",
  "source": {
    "origin": "https://nextcloud.example.invalid",
    "user": "YOUR_NEXTCLOUD_USER",
    "root": "MyMind",
    "envFile": "/private/server/path/existing-sync.env"
  },
  "target": {
    "origin": "https://karakeep.example.invalid",
    "tokenFile": "/private/server/path/scoped-import-token"
  },
  "backupPlanFile": "/private/server/path/client-state/backup-plan.json",
  "backupDestination": {
    "ownerApproved": true,
    "kind": "local_other_disk",
    "separatePhysicalDisk": true,
    "snapshotDirectory": "/private/server/path/completed-snapshot"
  }
}
```

`source.envFile` supplies existing NEXTCLOUD_BASE_URL, NEXTCLOUD_USER,
NEXTCLOUD_FOLDER and NEXTCLOUD_APP_PASSWORD. The first three must agree with the
configuration. The target token needs the foundation's scoped import and
original/bookmark read permissions. Origins are fixed; redirects are refused.
Raw server error bodies and credentials never appear in CLI output.

Run from this directory **on the server** after configuration:

```sh
python3 -m migration_client --config /private/server/config.json seed
python3 -m migration_client --config /private/server/config.json status
python3 -m migration_client --config /private/server/config.json backup-plan
python3 -m migration_client --config /private/server/config.json dry-run --limit 1
```

`backup-plan` makes no network calls. For the owner's accepted temporary
other-disk destination it verifies the complete local snapshot spec and exact
current/recovery revision coverage against this client's manifest, then reports
`local_other_disk_verified`, `offHost=false`, `independentBackupVerified=false`.
The backup's separate-physical-disk placement is an operator assertion supported
by the snapshot operation's device check. A future off-host destination remains
a separate improvement. A mere destination declaration is not backup proof.

## Pilot approval and resume

The owner accepted a verified temporary other-disk backup for preparing a bounded
copy pilot. The pilot guard accepts the verified temporary snapshot. A declared
off-host destination is only a plan and cannot pass this guard; no unimplemented
off-host verification path is treated as backup proof. The temporary snapshot
does not authorize a pilot by itself. An operator must prepare a private approval
document with `phase="bounded-pilot"`, `approvedByOwner=true`, exact
`manifestDigest`, exact `targetOrigin`, `backupPlanDigest`, `maxItems` (1–12), and
`maxBytes` (1–268435456), and the exact `itemKeys` (1–12 unique journal keys).
Those keys define the complete approved subset across every resume; rerunning
the command cannot advance into other pending objects. Their combined bytes
must fit the approved budget. Derive the digests from the frozen server manifest and
backup-plan JSON using `migration_client.core.digest`; never fabricate approval.

```sh
python3 -m migration_client --config /private/server/config.json pilot \
  --limit 1 --max-bytes 52428800 --approval /private/server/approved-pilot.json
python3 -m migration_client --config /private/server/config.json reconcile --limit 1
```

After an interrupted run, rerun the same approved command and same state
directory. Do not change the account namespace or manually clear holds. There is
one process lock per journal; the SQLite database belongs only to this client.
No source deletion guard or worker policy is changed by this tool.

## Standalone snapshot and restore

`backup_snapshot.py` implements the separately authorized, dated snapshot of the
frozen 6498-file audit and four recovery copies. It needs `requests` on Linux,
checks that the approved backup parent is on neither source disk, and stores no
credentials. It is intentionally specific to the accepted server paths and
scope, not a general backup scheduler. Never start it again to inspect status.
`--resume EXISTING_SNAPSHOT` reuses its checkpoint after an interrupted copy;
held records are not silently retried. `--finalize-only EXISTING_SNAPSHOT` is a
one-time, network-free addition of an explicit restore map to a completed copy.

The final snapshot has `restore-spec.json`, `RESTORE.md` with an autonomous
standard-library verifier, an explicit map of every original/recovery file to
its source object/path/revision, unchanged original provenance, and a consistent
source SQLite backup. Full byte reread and a separate small restore are required
before its summary can be verified. A small restore is not a full application
restore or evidence of survival after losing the homeserver.

The client `restore-spec` command is only a **draft expected-member plan** for
client-key filenames. It intentionally reports `completeBackupSpecification=false`
until source SQLite/audit and repository provenance are incorporated. For the
actual dated snapshot, use the complete spec generated by `backup_snapshot.py`;
do not substitute this draft for it. `verify-restore --spec ... --restored-root ...`
hashes a restored directory and checks SQLite integrity, and never infers off-host
independence from hashes alone.

## Verification

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

Tests use synthetic originals, synthetic IDs and a loopback HTTP fixture. They
cover crash/resume checkpoints, uncertain reserve/upload/commit responses,
lease/fence renewal, changed source identity or bytes, exact original/metadata
and display readback, deferred capability failure, duplicate-source isolation,
scope/budget gates, cached evidence seeding, backup mapping and corruption,
small restore and temporary-backup pilot approval. The fixture is not the actual
foundation handler; real-handler interoperability and an approved live pilot
must be verified separately before production readiness is claimed.
