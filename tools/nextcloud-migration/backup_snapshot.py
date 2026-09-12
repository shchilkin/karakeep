#!/usr/bin/env python3
"""Standalone server-only snapshot of the accepted MyMind export evidence.

No source mutations, mymind API, model calls, credentials in the snapshot, or
off-host transfer. GET exists solely to preserve bytes on an approved other disk.
Requires requests on the server. Resume reads the frozen checkpoint, not new scope.
"""
import argparse
import collections
import datetime
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import sqlite3
import sys
import time
from urllib.parse import quote, unquote, urlsplit
import uuid
import xml.etree.ElementTree as ET


def sha_file(path):
    sha, size = hashlib.sha256(), 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            sha.update(chunk)
            size += len(chunk)
    return sha.hexdigest(), size


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def jsonl(path):
    with path.open() as source:
        for line in source:
            yield json.loads(line)


def write_json(path, value):
    temporary = path.with_name(path.name + ".part")
    if temporary.is_symlink() or path.is_symlink():
        raise RuntimeError("symlink_snapshot_metadata")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as out:
        out.write(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2).encode() + b"\n")
        out.flush()
        os.fsync(out.fileno())
    temporary.replace(path)
    fsync_dir(path.parent)


def copy_local(source, destination):
    if source.is_symlink() or not source.is_file() or destination.is_symlink():
        raise RuntimeError("invalid_local_member")
    destination.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    if destination.exists():
        raise RuntimeError("snapshot_member_exists")
    temporary = destination.with_name(destination.name + ".part")
    with source.open("rb") as inp, temporary.open("xb") as out:
        shutil.copyfileobj(inp, out, 1024 * 1024)
        out.flush()
        os.fsync(out.fileno())
    temporary.replace(destination)
    fsync_dir(destination.parent)
    if sha_file(source) != sha_file(destination):
        raise RuntimeError("local_copy_reread_mismatch")
    return sha_file(destination)


def seal_restore_spec(snapshot):
    """Final expected-member hash index; does not read Nextcloud or any credentials."""
    snapshot = Path(snapshot).resolve()
    summary = json.loads((snapshot / 'summary.json').read_text())
    if summary.get('state') != 'local_other_disk_verified':
        raise RuntimeError('cannot_seal_incomplete_snapshot')
    db = sqlite3.connect((snapshot / 'checkpoint.sqlite').as_uri() + '?mode=ro&immutable=1', uri=True)
    if (db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok'
            or db.execute('PRAGMA foreign_key_check').fetchone() is not None):
        raise RuntimeError('snapshot_checkpoint_integrity')
    members = []
    for destination, sha, size, state in db.execute('SELECT destination,sha256,size,state FROM files ORDER BY n'):
        if state != 'verified' or not destination.startswith('originals/'):
            raise RuntimeError('cannot_seal_unverified_member')
        members.append({'relativePath': destination, 'sha256': sha, 'size': size, 'kind': 'original'})
    if len(members) != summary['currentFiles']:
        raise RuntimeError('snapshot_member_count_mismatch')
    for relative, sha, size in db.execute('SELECT relative_path,sha256,size FROM local_members ORDER BY relative_path'):
        if not relative.startswith(('metadata/', 'recovery/')) and relative != 'RESTORE.md':
            raise RuntimeError('invalid_local_member_path')
        members.append({'relativePath': relative, 'sha256': sha, 'size': size,
                        'kind': 'sqlite' if relative.endswith('.sqlite') else 'metadata'})
    db.close()
    for name in ['checkpoint.sqlite', 'snapshot.json', 'summary.json']:
        sha, size = sha_file(snapshot / name)
        members.append({'relativePath': name, 'sha256': sha, 'size': size,
                        'kind': 'sqlite' if name.endswith('.sqlite') else 'metadata'})
    if any('..' in Path(member['relativePath']).parts for member in members):
        raise RuntimeError('invalid_backup_member_path')
    result = {'schemaVersion': 1, 'members': members, 'completeBackupSpecification': True,
              'sourceSyncDatabaseIncluded': True, 'offHost': False,
              'scope': 'accepted_export_blob_set_plus_frozen_audit_and_four_recovery_copies',
              'independentBackupVerified': False}
    write_json(snapshot / 'restore-spec.json', result)
    return {'expectedMembers': len(members), 'expectedBytes': sum(m['size'] for m in members),
            'offHost': False, 'completeBackupSpecification': True}


def finalize_snapshot(snapshot):
    """Add self-contained restore mapping without changing original provenance."""
    snapshot = Path(snapshot).resolve()
    summary = json.loads((snapshot / 'summary.json').read_text())
    if summary.get('state') != 'local_other_disk_verified':
        raise RuntimeError('cannot_finalize_incomplete_snapshot')
    mapping = snapshot / 'metadata/restore-map.jsonl'
    instruction = snapshot / 'RESTORE.md'
    if mapping.exists() or instruction.exists():
        raise RuntimeError('restore_mapping_already_exists')
    db = sqlite3.connect(snapshot / 'checkpoint.sqlite')
    db.row_factory = sqlite3.Row
    records = []
    for row in db.execute('SELECT * FROM files ORDER BY n'):
        if row['state'] != 'verified':
            raise RuntimeError('unverified_restore_mapping_member')
        records.append({'backupRelativePath': row['destination'], 'objectId': row['source_id'],
                        'sourcePath': row['source_path'], 'revisionKind': 'current',
                        'fileId': row['file_id'], 'etag': row['etag'],
                        'sha256': row['sha256'], 'size': row['size'],
                        'exportedSha256': row['exported_sha256'], 'exportedSize': row['exported_size'],
                        'sourceDiverged': row['sha256'] != row['exported_sha256'],
                        'metadataRecord': 'metadata/source-sync.sqlite:objects',
                        'holdForOwnerReview': row['sha256'] != row['exported_sha256']})
    recovery_record = db.execute('SELECT * FROM local_members WHERE relative_path=?', ('metadata/recovery-manifest.jsonl',)).fetchone()
    if recovery_record is None or sha_file(snapshot / recovery_record['relative_path']) != (recovery_record['sha256'], recovery_record['size']):
        raise RuntimeError('recovery_manifest_snapshot_changed')
    recovery = list(jsonl(snapshot / 'metadata/recovery-manifest.jsonl'))
    if len(recovery) != 4:
        raise RuntimeError('recovery_restore_mapping_scope')
    for n, record in enumerate(recovery, 1):
        relative = f'recovery/{n:06d}.bin'
        # Establish the explicit file -> source record linkage by actual bytes,
        # not by assuming future users know how JSONL order was copied.
        if sha_file(snapshot / relative) != (record['sha256'], record['size']):
            raise RuntimeError('recovery_restore_mapping_hash_mismatch')
        records.append({'backupRelativePath': relative, 'objectId': record['source_object_id'],
                        'sourcePath': record['original_path'], 'revisionKind': record['revision'],
                        'versionId': record['source_version_id'], 'fileId': record['source_fileid'],
                        'etag': record['response_etag'], 'sha256': record['sha256'], 'size': record['size'],
                        'detectedContentType': record['detected_content_type'],
                        'exportedSha256': record['source_metadata']['sha256'],
                        'exportedSize': record['source_metadata']['size'],
                        'provenanceRecord': 'metadata/recovery-manifest.jsonl',
                        'holdForOwnerReview': True})
    temporary = mapping.with_name(mapping.name + '.part')
    with temporary.open('xb') as output:
        for record in records:
            output.write(json.dumps(record, ensure_ascii=False, sort_keys=True).encode() + b'\n')
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(mapping)
    fsync_dir(mapping.parent)
    instructions = '''# Restore this snapshot (server only)

This is a verified backup on another physical disk of the SAME homeserver.
offHost=false; losing the whole server can lose this backup too. Scope: the
accepted 6498 current exported blobs, sync metadata/audit, and four preserved
current/historical revisions. It is not the complete original mymind library.

1. Copy this snapshot into a new private recovery directory (0700, files0600).
   Never copy directly into a running Nextcloud or Karakeep data directory.
   Do not overwrite another snapshot or an existing recovery directory.
2. Verify every member in restore-spec.json by streaming SHA-256 and exact byte
   count. Run integrity_check and foreign_key_check on copied SQLite databases.
   The offline command below needs only Python's standard library.
3. metadata/restore-map.jsonl maps EVERY originals/NNNNNN.bin and each of the
   four recovery/NNNNNN.bin to objectId, original path, current/historical
   revision, SHA/size, and metadata location. This explicit mapping is the
   restore index. It does not depend on /srv/appdata, the old recovery stage,
   JSONL ordering knowledge, or continued access to Nextcloud Versions.
4. metadata/source-sync.sqlite contains the original source metadata in objects;
   metadata/source-inventory.jsonl and source-byte-verification.jsonl preserve
   the audit evidence. metadata/recovery-manifest.jsonl is unchanged provenance;
   its old stage_path is historical context, NOT a required restore location.
5. Keep divergent current and historical revisions separate and held for owner
   review. Restoring bytes is not permission to replace current files or delete
   source data. Any later restore into Nextcloud must use its supported WebDAV
   API, exact approved mapping, no overwrite, and independent verification.

No credentials are included. Configure fresh scoped credentials locally only
if/when an approved application restore is needed. Do not copy media, full
manifests, file hashes, object IDs or URLs to the Mac/chat.

Verify a COMPLETE restored copy (replace the example directory):

```sh
python3 - /path/to/private/restored-copy <<'PY'
import hashlib, json, pathlib, sqlite3, sys
root = pathlib.Path(sys.argv[1]).resolve()
spec = json.loads((root / 'restore-spec.json').read_text())
assert spec['schemaVersion'] == 1 and spec['members']
for member in spec['members']:
    path = root / member['relativePath']
    assert path.resolve().is_relative_to(root) and not path.is_symlink()
    sha, size = hashlib.sha256(), 0
    with path.open('rb') as source:
        while chunk := source.read(1024 * 1024):
            sha.update(chunk)
            size += len(chunk)
    assert (sha.hexdigest(), size) == (member['sha256'], member['size'])
    if member['kind'] == 'sqlite':
        db = sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert db.execute('PRAGMA foreign_key_check').fetchone() is None
        db.close()
print('All expected restored members and SQLite databases verified.')
PY
```
'''
    with instruction.open('x') as output:
        output.write(instructions)
        output.flush()
        os.fsync(output.fileno())
    fsync_dir(snapshot)
    restore = Path(summary['restoreDirectory']).resolve()
    if restore.parent != snapshot.parent or restore == snapshot:
        raise RuntimeError('restore_directory_outside_snapshot_parent')
    for path in [mapping, instruction]:
        copy_local(path, restore / path.relative_to(snapshot))
    restored_map = list(jsonl(restore / 'metadata/restore-map.jsonl'))
    restored_recovery_checks = 0
    for record in restored_map:
        if not record['backupRelativePath'].startswith('recovery/'):
            continue
        if sha_file(restore / record['backupRelativePath']) != (record['sha256'], record['size']):
            raise RuntimeError('restored_recovery_mapping_hash_mismatch')
        restored_recovery_checks += 1
    if restored_recovery_checks != 4:
        raise RuntimeError('restored_recovery_mapping_scope')
    restore_receipt = json.loads((restore / 'restore-receipt.json').read_text())
    for path in [mapping, instruction]:
        relative = str(path.relative_to(snapshot))
        sha, size = sha_file(restore / relative)
        restore_receipt['members'].append({'relativePath': relative, 'sha256': sha, 'size': size})
    restore_receipt['explicitRecoveryMappingByteChecks'] = restored_recovery_checks
    restore_receipt['mappingVerifiedAt'] = now()
    write_json(restore / 'restore-receipt.json', restore_receipt)
    with db:
        for path in [mapping, instruction]:
            sha, size = sha_file(path)
            db.execute('INSERT INTO local_members VALUES(?,?,?,?)', (str(path.relative_to(snapshot)), sha, size, 'restore_metadata'))
    db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
    summary.update({'restoreMapOriginals': len(records) - 4, 'restoreMapRecovery': 4,
                    'recoveryMappingByteChecks': 4, 'restoreMapSelfContained': True,
                    'restoredMappingRecoveryByteChecks': restored_recovery_checks,
                    'restoredMembersVerified': summary['restoredMembersVerified'] + 2})
    write_json(snapshot / 'summary.json', summary)
    spec = seal_restore_spec(snapshot)
    # Check the final frozen spec, including new map and updated journal/summary.
    expected = json.loads((snapshot / 'restore-spec.json').read_text())
    for member in expected['members']:
        path = snapshot / member['relativePath']
        if not path.resolve().is_relative_to(snapshot) or path.is_symlink():
            raise RuntimeError('final_restore_spec_path')
        if sha_file(path) != (member['sha256'], member['size']):
            raise RuntimeError('final_restore_spec_mismatch')
    return {**spec, 'allSpecMembersReadbackVerified': True,
            'restoreMapOriginals': len(records) - 4, 'restoreMapRecovery': 4,
            'recoveryMappingByteChecks': 4, 'restoreMapSelfContained': True,
            'restoredMappingRecoveryByteChecks': restored_recovery_checks}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", default="/srv/appdata/karakeep/nextcloud-migration-audit-20260912")
    parser.add_argument("--source-config", default="/srv/appdata/mymind-sync/.env")
    parser.add_argument("--sync-db", default="/srv/appdata/mymind-sync/state/sync.db")
    parser.add_argument("--destination-parent", default="/home/shchilkin/backups")
    parser.add_argument("--resume")
    parser.add_argument("--finalize-only", help="Add explicit restore map to a completed snapshot; no network")
    args = parser.parse_args()
    if sys.platform != "linux":
        raise RuntimeError("server_only_execution_required")
    if args.finalize_only:
        os.umask(0o077)
        snapshot = Path(args.finalize_only).resolve()
        if snapshot.parent != Path(args.destination_parent).resolve():
            raise RuntimeError("snapshot_outside_approved_parent")
        print(json.dumps({'snapshot': str(snapshot), 'stage': 'finalized', **finalize_snapshot(snapshot)}), flush=True)
        return 0
    import requests
    os.umask(0o077)
    evidence = Path(args.evidence).resolve()
    parent = Path(args.destination_parent)
    if parent.is_symlink():
        raise RuntimeError("symlink_destination")
    parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    parent = parent.resolve()
    # For this explicitly approved live run, backup must not share either source disk.
    if parent.stat().st_dev in {Path('/srv/storage').stat().st_dev, Path('/srv/appdata').stat().st_dev}:
        raise RuntimeError("backup_is_not_on_other_disk")
    if shutil.disk_usage(parent).free < 40 * 1024**3:
        raise RuntimeError("backup_disk_reserve")
    cfg = {}
    config_path = Path(args.source_config)
    if config_path.stat().st_mode & 0o077:
        raise RuntimeError("source_config_not_private")
    for line in config_path.read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            cfg[key.strip()] = ' '.join(shlex.split(value))
    origin = cfg['NEXTCLOUD_BASE_URL'].rstrip('/')
    owner = cfg['NEXTCLOUD_USER']
    root = cfg.get('NEXTCLOUD_FOLDER', 'MyMind').strip('/')
    prefix = '/remote.php/dav/files/' + quote(owner, safe='') + '/'
    session = requests.Session()
    session.trust_env = False
    session.auth = (owner, cfg['NEXTCLOUD_APP_PASSWORD'])
    session.headers.update({'Accept-Encoding': 'identity', 'User-Agent': 'MyMindOtherDiskBackup/1.0'})
    if args.resume:
        snapshot = Path(args.resume).resolve()
        if snapshot.parent != parent or not snapshot.name.startswith('mymind-migration-20260912'):
            raise RuntimeError("resume_outside_approved_parent")
        setup = json.loads((snapshot / 'snapshot.json').read_text())
        if setup['sourceOrigin'] != origin or setup['sourceOwner'] != owner or setup['sourceRoot'] != root:
            raise RuntimeError("resume_source_changed")
    else:
        snapshot = parent / 'mymind-migration-20260912'
        if snapshot.exists():
            snapshot = parent / ('mymind-migration-20260912-' + uuid.uuid4().hex[:12])
        snapshot.mkdir(mode=0o700)
        for directory in ['originals', 'metadata', 'recovery']:
            (snapshot / directory).mkdir(mode=0o700)
        setup = {'schemaVersion': 1, 'startedAt': now(), 'sourceOrigin': origin,
                 'sourceOwner': owner, 'sourceRoot': root, 'snapshot': str(snapshot),
                 'offHost': False, 'sourceScope': 'accepted_6498_exported_current_blobs_plus_metadata_and_four_recovery_copies',
                 'physicalDevice': snapshot.stat().st_dev}
        write_json(snapshot / 'snapshot.json', setup)
    db = sqlite3.connect(snapshot / 'checkpoint.sqlite')
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=FULL')
    db.execute('CREATE TABLE IF NOT EXISTS files(n INTEGER PRIMARY KEY, source_path TEXT, source_id TEXT, etag TEXT, file_id TEXT, sha256 TEXT, size INTEGER, exported_sha256 TEXT, exported_size INTEGER, destination TEXT, state TEXT DEFAULT "pending", error TEXT)')
    db.execute('CREATE TABLE IF NOT EXISTS local_members(relative_path TEXT PRIMARY KEY, sha256 TEXT, size INTEGER, kind TEXT)')
    if not args.resume:
        inventory = {r['path']: r for r in jsonl(evidence / 'source-inventory.jsonl')}
        verified = {r['path']: r for r in jsonl(evidence / 'source-byte-verification.jsonl')}
        if len(inventory) != 6498 or len(verified) != 6498:
            raise RuntimeError("accepted_source_scope_changed")
        source_db = sqlite3.connect(Path(args.sync_db).resolve().as_uri() + '?mode=ro', uri=True)
        backup_db = sqlite3.connect(snapshot / 'metadata/source-sync.sqlite')
        source_db.backup(backup_db)
        source_db.close()
        if backup_db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError("source_database_integrity")
        backup_db.row_factory = sqlite3.Row
        exported = {r['remote_path']: dict(r) for r in backup_db.execute('SELECT * FROM objects')}
        backup_db.close()
        if set(exported) != set(inventory):
            raise RuntimeError("source_database_scope_changed")
        with db:
            for n, (path, inv) in enumerate(sorted(inventory.items()), 1):
                record = verified[path]
                if (record.get('http_status') != 200 or record['bytes'] != inv['size']
                        or not path.startswith(root + '/') or any(p in ('', '.', '..') for p in path.split('/'))
                        or not inv['properties'].get('{DAV:}getetag') or record['bytes'] > 150 * 1024**2):
                    raise RuntimeError("invalid_frozen_source_evidence")
                db.execute('INSERT INTO files(n,source_path,source_id,etag,file_id,sha256,size,exported_sha256,exported_size,destination) VALUES(?,?,?,?,?,?,?,?,?,?)',
                           (n, path, exported[path]['object_id'], inv['properties']['{DAV:}getetag'],
                            inv['properties']['{http://owncloud.org/ns}fileid'], record['sha256'], record['bytes'],
                            exported[path]['sha256'], exported[path]['size'], f'originals/{n:06d}.bin'))
        local_paths = ['source-inventory.jsonl', 'source-byte-verification.jsonl', 'summary.json',
                       'format-probes.jsonl', 'format-summary.json', 'version-verification.jsonl',
                       'version-summary.json', 'recovery-summary.json', 'revalidation-summary.json']
        for name in local_paths:
            copy_local(evidence / name, snapshot / 'metadata' / name)
        for path in evidence.glob('versions-*.xml'):
            copy_local(path, snapshot / 'metadata' / path.name)
        copy_local(evidence / 'recovery-staging/manifest.jsonl', snapshot / 'metadata/recovery-manifest.jsonl')
        recovery = list(jsonl(evidence / 'recovery-staging/manifest.jsonl'))
        if len(recovery) != 4:
            raise RuntimeError("accepted_recovery_scope_changed")
        for n, record in enumerate(recovery, 1):
            source = Path(record['stage_path'])
            if not source.resolve().is_relative_to((evidence / 'recovery-staging').resolve()):
                raise RuntimeError("recovery_path_outside_root")
            actual = copy_local(source, snapshot / 'recovery' / f'{n:06d}.bin')
            if actual != (record['sha256'], record['size']):
                raise RuntimeError("recovery_evidence_mismatch")
        with db:
            for directory in ['metadata', 'recovery']:
                for path in (snapshot / directory).iterdir():
                    sha, size = sha_file(path)
                    db.execute('INSERT INTO local_members VALUES(?,?,?,?)', (str(path.relative_to(snapshot)), sha, size, directory))
    expected_bytes = db.execute('SELECT sum(size) FROM files').fetchone()[0]
    if expected_bytes > 6 * 1024**3:
        raise RuntimeError("snapshot_byte_budget")
    print(json.dumps({'snapshot': str(snapshot), 'stage': 'copying_current_files', 'currentFiles': 6498,
                      'currentBytes': expected_bytes, 'offHost': False}), flush=True)
    body = b'<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:getetag/><d:getcontentlength/><oc:fileid/><d:resourcetype/></d:prop></d:propfind>'
    deadline = time.monotonic() + 2 * 60 * 60
    processed = 0
    errors = 0
    for row in db.execute('SELECT * FROM files ORDER BY n').fetchall():
        destination = snapshot / row['destination']
        if row['state'] == 'verified':
            if sha_file(destination) != (row['sha256'], row['size']):
                raise RuntimeError("resumed_snapshot_changed")
            processed += 1
            continue
        if row['state'] == 'hold':
            errors += 1
            continue
        if time.monotonic() > deadline:
            break
        try:
            url = origin + prefix + quote(row['source_path'], safe='/')
            with session.request('PROPFIND', url, data=body, headers={'Depth': '0', 'Content-Type': 'application/xml'}, timeout=(10, 90), allow_redirects=False) as response:
                if response.status_code != 207 or len(response.content) > 65536:
                    raise RuntimeError('source_propfind_failed')
                tree = ET.fromstring(response.content)
                responses = tree.findall('{DAV:}response')
                if len(responses) != 1 or unquote(urlsplit(responses[0].findtext('{DAV:}href', '')).path) != unquote(prefix + quote(row['source_path'], safe='/')):
                    raise RuntimeError('source_identity_changed')
                entry = responses[0]
                properties = {}
                for propstat in entry.findall('{DAV:}propstat'):
                    if ' 200 ' in propstat.findtext('{DAV:}status', ''):
                        for prop in propstat.find('{DAV:}prop'):
                            properties[prop.tag] = prop.text
                if (properties.get('{DAV:}getetag') != row['etag']
                        or properties.get('{http://owncloud.org/ns}fileid') != row['file_id']
                        or int(properties.get('{DAV:}getcontentlength', '-1')) != row['size']
                        or entry.find('.//{DAV:}collection') is not None):
                    raise RuntimeError('source_identity_changed')
            if destination.exists():
                if sha_file(destination) != (row['sha256'], row['size']):
                    raise RuntimeError('snapshot_existing_file_conflict')
            else:
                temporary = destination.with_name(destination.name + '.part')
                sha, counted = hashlib.sha256(), 0
                started = time.monotonic()
                with session.get(url, headers={'If-Match': row['etag']}, stream=True, timeout=(10, 90), allow_redirects=False) as response:
                    if (response.status_code != 200 or response.headers.get('ETag') != row['etag']
                            or response.headers.get('Content-Encoding', 'identity').lower() != 'identity'):
                        raise RuntimeError('source_get_precondition_failed')
                    with temporary.open('wb') as output:
                        for chunk in response.iter_content(1024 * 1024):
                            if time.monotonic() - started > 120:
                                raise RuntimeError('source_stream_deadline')
                            counted += len(chunk)
                            if counted > row['size']:
                                raise RuntimeError('source_exceeded_expected_size')
                            sha.update(chunk)
                            output.write(chunk)
                            wait = counted / (16 * 1024**2) - (time.monotonic() - started)
                            if wait > 0:
                                time.sleep(wait)
                        output.flush()
                        os.fsync(output.fileno())
                if (sha.hexdigest(), counted) != (row['sha256'], row['size']):
                    raise RuntimeError('source_bytes_changed')
                temporary.replace(destination)
                fsync_dir(destination.parent)
                if sha_file(destination) != (row['sha256'], row['size']):
                    raise RuntimeError('snapshot_reread_mismatch')
            with db:
                db.execute('UPDATE files SET state="verified",error=NULL WHERE n=?', (row['n'],))
            processed += 1
        except Exception as error:
            # Error class/code only on stdout. Identity stays solely in checkpoint.
            code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
            with db:
                db.execute('UPDATE files SET state="hold",error=? WHERE n=?', (code, row['n']))
            errors += 1
        if (processed + errors) % 100 == 0 or errors:
            print(json.dumps({'stage': 'copying_current_files', 'verified': processed,
                              'holds': errors, 'total': 6498}), flush=True)
        if errors >= 3:
            break
    counts = dict(db.execute('SELECT state,count(*) FROM files GROUP BY state').fetchall())
    print(json.dumps({'stage': 'final_reread', 'states': counts}), flush=True)
    reread = 0
    for row in db.execute('SELECT * FROM files WHERE state="verified"'):
        if sha_file(snapshot / row['destination']) != (row['sha256'], row['size']):
            raise RuntimeError('final_reread_mismatch')
        reread += 1
    local_verified = 0
    for row in db.execute('SELECT * FROM local_members'):
        if sha_file(snapshot / row['relative_path']) != (row['sha256'], row['size']):
            raise RuntimeError('local_metadata_reread_mismatch')
        local_verified += 1
    restore = parent / (snapshot.name + '-restore-check-' + uuid.uuid4().hex[:8])
    restore.mkdir(mode=0o700)
    restored_members = []
    selected = []
    candidates = db.execute('SELECT * FROM files WHERE state="verified" ORDER BY size').fetchall()
    for predicate in [lambda r: r['source_path'].endswith(('.jpg', '.png')), lambda r: r['source_path'].endswith('.mp4'), lambda r: r['sha256'] != r['exported_sha256']]:
        row = next((r for r in candidates if predicate(r)), None)
        if row and row['destination'] not in selected:
            selected.append(row['destination'])
    selected += ['metadata/source-sync.sqlite', 'metadata/source-inventory.jsonl', 'metadata/recovery-manifest.jsonl']
    selected += [r[0] for r in db.execute('SELECT relative_path FROM local_members WHERE kind="recovery" ORDER BY relative_path')]
    for relative in selected:
        sha, size = copy_local(snapshot / relative, restore / relative)
        restored_members.append({'relativePath': relative, 'sha256': sha, 'size': size})
    restore_db = sqlite3.connect((restore / 'metadata/source-sync.sqlite').as_uri() + '?mode=ro', uri=True)
    integrity = restore_db.execute('PRAGMA integrity_check').fetchone()[0]
    rows_count = restore_db.execute('SELECT count(*) FROM objects').fetchone()[0]
    restore_db.close()
    if integrity != 'ok' or rows_count != 6498:
        raise RuntimeError('restore_sqlite_verification_failed')
    write_json(restore / 'restore-receipt.json', {'snapshot': str(snapshot), 'members': restored_members,
                                               'sqliteIntegrity': integrity, 'sqliteObjects': rows_count, 'verifiedAt': now()})
    db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
    for path in list(snapshot.rglob('*')) + list(restore.rglob('*')):
        os.chmod(path, 0o700 if path.is_dir() else 0o600)
    complete = counts.get('verified') == 6498 and reread == 6498 and not counts.get('hold') and not counts.get('pending')
    summary = {'snapshot': str(snapshot), 'startedAt': setup['startedAt'], 'finishedAt': now(),
               'state': 'local_other_disk_verified' if complete else 'incomplete_hold',
               'currentFiles': 6498, 'currentBytes': expected_bytes, 'states': counts,
               'originalsRereadVerified': reread, 'localMetadataAndRecoveryMembersVerified': local_verified,
               'recoveryCopies': 4, 'recoveryBytes': 19406576,
               'restoreDirectory': str(restore), 'restoredMembersVerified': len(restored_members),
               'restoredSqliteIntegrity': integrity, 'restoredSqliteObjects': rows_count,
               'offHost': False, 'survivesHomeserverLoss': False, 'nextcloudMutations': 0,
               'sourceScope': 'accepted_export_blob_set_not_full_mymind_or_all_versions',
               'directoryMode': oct(snapshot.stat().st_mode & 0o777),
               'fileModes': sorted({oct(p.stat().st_mode & 0o777) for p in snapshot.rglob('*') if p.is_file()})}
    write_json(snapshot / 'summary.json', summary)
    if complete:
        print(json.dumps({'stage': 'restore_spec_sealed', **finalize_snapshot(snapshot)}), flush=True)
    print(json.dumps(summary), flush=True)
    return 0 if complete else 2


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'state': 'incomplete_hold', 'error': str(error) if isinstance(error, RuntimeError) else type(error).__name__}), flush=True)
        raise SystemExit(2)
