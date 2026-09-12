import json
import sqlite3
from pathlib import Path

from .core import (Failure, atomic_write, canonical, check_file, digest, file_hash,
                   inside, read_json)


def plan(manifest, destination=None):
    """Planning only: no repository connection, archive transfer or paid service."""
    docs = [json.loads(r[0]) for r in manifest.connection.execute("SELECT document FROM items")]
    currents = [d for d in docs if not d.get("preservedRevision")]
    recovery = [d for d in docs if d.get("preservedRevision")]
    expected_bytes = sum(d["observed"]["size"] for d in currents + recovery)
    destination_ready = bool(destination and destination.get("ownerApproved") is True
                             and destination.get("survivesHostLoss") is True
                             and destination.get("encrypted") is True
                             and destination.get("recoveryKeySeparatelyAvailable") is True
                             and isinstance(destination.get("destinationRef"), str)
                             and destination["destinationRef"]
                             and type(destination.get("availableBytes")) is int
                             and destination["availableBytes"] >= expected_bytes + 1024**3)
    temporary = None
    if destination and destination.get("ownerApproved") is True and destination.get("kind") == "local_other_disk":
        temporary = verify_temporary_snapshot(manifest, destination)
    state = ("local_other_disk_verified" if temporary else
             "destination_declared_needs_snapshot_restore" if destination_ready else
             "destination_selection_required")
    return {
        "schemaVersion": 1, "manifestDigest": manifest.snapshot_digest(),
        "state": state,
        "scope": "exported_blob_set_plus_metadata_and_recovery_revisions",
        "currentFiles": len(currents), "recoveryCopies": len(recovery),
        "minimumMediaBytes": expected_bytes,
        "metadataBytes": sum(len(canonical(d)) for d in docs),
        "stagingReserveBytes": 40 * 1024**3,
        "unmeasured": ["all_nextcloud_versions", "nextcloud_comments_and_system_tags"],
        "destinationDeclaration": destination or None,
        "temporaryBackup": temporary,
        "offHost": False if temporary else None,
        "offHostImprovement": "pending" if temporary else "destination_selection_required",
        "independentBackupVerified": False,
        "nextSteps": (["prepare_bounded_copy_pilot_with_explicit_owner_approval",
                       "add_verified_off_host_backup_before_any_future_source_deletion"] if temporary else
                     ["stage_exact_source_bytes_via_webdav_under_separate_approved_backup_plan",
                      "snapshot_originals_sync_db_metadata_audit_and_four_recovery_copies",
                      "record_encrypted_off_host_snapshot_and_restore_provenance",
                      "verify_every_restored_member_hash_and_sqlite_integrity"]),
        "networkCalls": 0,
    }


def verify_temporary_snapshot(manifest, destination):
    """Accept the owner's temporary other-disk decision with actual local evidence.

    Rehashes the completed snapshot locally; never queries Nextcloud. Its explicit
    map must cover this frozen client's source revision set exactly.
    """
    root = Path(destination["snapshotDirectory"]).resolve()
    summary = read_json(inside(root, "summary.json"))
    spec_path = inside(root, "restore-spec.json")
    spec = read_json(spec_path, limit=64 * 1024 * 1024)
    if (destination.get("separatePhysicalDisk") is not True
            or summary.get("state") != "local_other_disk_verified"
            or summary.get("offHost") is not False
            or summary.get("survivesHomeserverLoss") is not False
            or summary.get("restoreMapSelfContained") is not True
            or summary.get("restoredMappingRecoveryByteChecks") != 4
            or summary.get("restoredSqliteIntegrity") != "ok"
            or spec.get("completeBackupSpecification") is not True
            or spec.get("sourceSyncDatabaseIncluded") is not True):
        raise Failure("temporary_backup_evidence_incomplete")
    from .source import jsonl
    mapping = list(jsonl(inside(root, "metadata/restore-map.jsonl")))
    def identity(object_id, path, kind, sha, size, preserved):
        return (object_id, path, kind, sha, size, preserved)
    actual = []
    for record in mapping:
        kind = "historical" if record["revisionKind"].startswith("historical") else "current"
        actual.append(identity(record["objectId"], record["sourcePath"], kind,
                               record["sha256"], record["size"],
                               record["backupRelativePath"].startswith("recovery/")))
    expected = []
    for row in manifest.connection.execute("SELECT document FROM items"):
        doc = json.loads(row[0])
        expected.append(identity(doc["sourceObjectId"], doc["path"], doc["revisionKind"],
                                 doc["observed"]["sha256"], doc["observed"]["size"],
                                 bool(doc.get("preservedRevision"))))
    if not expected or sorted(actual) != sorted(expected):
        raise Failure("temporary_backup_manifest_mismatch")
    report = verify_restore(spec_path, root, manifest.root / "temporary-backup-readback.json")
    if not report["memberBytesVerified"]:
        raise Failure("temporary_backup_readback_failed")
    return {"state": "local_other_disk_verified", "specDigest": digest(spec),
            "membersVerified": report["verified"], "restoreMappingVerified": True,
            "offHost": False, "survivesHomeserverLoss": False,
            "independentBackupVerified": False}


def restore_spec(manifest, output):
    """Expected restore members derived from the frozen source journal.

    This does NOT assert these members already exist in a backup. Missing source
    or unsupported import files still belong in the backup's expected member set.
    """
    members = []
    for row in manifest.connection.execute("SELECT key,document FROM items ORDER BY key"):
        doc = json.loads(row["document"])
        prefix = "recovery" if doc.get("preservedRevision") else "originals"
        members.append({"relativePath": prefix + "/" + row["key"] + ".bin",
                        **doc["observed"], "kind": "original",
                        "sourceIdentity": {"objectId": doc["sourceObjectId"], "revisionKind": doc["revisionKind"]}})
        metadata = canonical(doc)
        import hashlib
        members.append({"relativePath": "metadata/" + row["key"] + ".json",
                        "sha256": hashlib.sha256(metadata).hexdigest(), "size": len(metadata),
                        "kind": "metadata"})
    # Consistent client journal snapshot; source sync DB is separately required.
    snapshot = manifest.root / "client-journal-snapshot.sqlite"
    if snapshot.is_symlink():
        raise Failure("symlink_state_file")
    manifest.backup_database(snapshot)
    sha, size = file_hash(snapshot)
    members.append({"relativePath": "metadata/client-journal.sqlite", "sha256": sha,
                    "size": size, "kind": "sqlite"})
    result = {"schemaVersion": 1, "manifestDigest": manifest.snapshot_digest(),
              "members": members, "sourceSyncDatabaseIncluded": False,
              "completeBackupSpecification": False,
              "remainingRequired": ["consistent_source_sync_db_snapshot_and_hash",
                                    "audit_manifest_and_recovery_manifest_snapshot_and_hash",
                                    "external_repository_snapshot_restore_provenance"],
              "independentBackupVerified": False}
    atomic_write(output, canonical(result))
    return {"members": len(members), "completeBackupSpecification": False,
            "independentBackupVerified": False}


def verify_restore(spec_path, restored_root, output):
    spec = read_json(spec_path, limit=64 * 1024 * 1024)
    members = spec.get("members")
    if spec.get("schemaVersion") != 1 or not isinstance(members, list) or len(members) > 50_000:
        raise Failure("invalid_restore_spec")
    expected_names = set()
    report = {"schemaVersion": 1, "specDigest": digest(spec), "verified": 0,
              "missing": 0, "mismatched": 0, "sqliteFailures": 0,
              "memberBytesVerified": False, "independentBackupVerified": False,
              "externalRestoreProvenance": "not_verified_by_local_hash_check"}
    for member in members:
        relative = member.get("relativePath")
        if not isinstance(relative, str) or relative in expected_names:
            raise Failure("invalid_restore_member")
        expected_names.add(relative)
        path = inside(restored_root, relative)
        if not path.is_file():
            report["missing"] += 1
            continue
        try:
            check_file(path, member["sha256"], member["size"])
        except Failure:
            report["mismatched"] += 1
            continue
        if member.get("kind") == "sqlite":
            connection = None
            try:
                connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
                if (connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok"
                        or connection.execute("PRAGMA foreign_key_check").fetchone() is not None):
                    raise sqlite3.DatabaseError()
            except sqlite3.DatabaseError:
                report["sqliteFailures"] += 1
                continue
            finally:
                if connection:
                    connection.close()
        report["verified"] += 1
    report["memberBytesVerified"] = bool(members) and report["verified"] == len(members)
    atomic_write(output, canonical(report))
    return report
