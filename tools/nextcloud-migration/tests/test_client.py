import copy
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from fixture_server import Fixture, PNG
from migration_client.backup import plan, restore_spec, verify_restore
from migration_client.cli import load_config, main, pilot_approval
from migration_client.core import Failure, canonical, digest, file_hash, inside
from migration_client.http import Http
from migration_client.manifest import Manifest
from migration_client.pipeline import dry_run, reconcile, run_pilot
from migration_client.source import WebDavSource, safe_source_path, seed_audit
from migration_client.target import BASE, Target, reservation_payload


class Crash(BaseException):
    pass


class ClientTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.fixture = Fixture()
        self.fixture.__enter__()
        self.source = WebDavSource(Http(self.fixture.origin, "Basic synthetic"), "fixture", "MyMind",
                                   rate_bytes=0, minimum_free=0)
        self.target = Target(Http(self.fixture.origin, "Bearer synthetic"), minimum_write_gap=0)
        self.namespace = {"ownerScope": "synthetic", "targetOrigin": self.fixture.origin}
        self.state = self.root / "state"

    def tearDown(self):
        self.fixture.__exit__(None, None, None)
        self.directory.cleanup()

    def journal(self):
        return Manifest(self.state, self.namespace)

    def seed(self, manifest, object_id="synthetic-one", body=PNG):
        return manifest.seed(self.fixture.document(object_id, body))

    def assert_hold(self, code, body=PNG, change=None):
        with self.journal() as manifest:
            key = self.seed(manifest, body=body)
            if change:
                change(manifest, key)
            with self.assertRaises(Failure) as failure:
                run_pilot(manifest, self.source, self.target)
            self.assertEqual(failure.exception.code, code)
            self.assertEqual(manifest.get(key)["hold"], code)
            self.assertEqual(manifest.summary()["phases"].get("verified", 0), 0)
        return key

    def test_full_copy_original_metadata_and_mapping_readback(self):
        with self.journal() as manifest:
            key = self.seed(manifest)
            summary = run_pilot(manifest, self.source, self.target)
            self.assertEqual(summary["phases"], {"verified": 1})
            item = manifest.get(key)
            receipt = item["receipt"]
            self.assertFalse(receipt["physicalReuse"])
            self.assertEqual(item["mime"], "image/png")
            self.assertTrue(item["document"]["path"].endswith(".json"))
            op = self.fixture.operations[receipt["operationId"]]
            self.assertEqual(op["metadata"], canonical(item["document"]))
            self.assertEqual(op["original"], PNG)
            self.assertEqual(op["payload"]["completeness"], "unknown")
            self.assertIsNone(op["payload"]["mapping"]["sourceUrl"])
            self.assertEqual(self.fixture.existing, self.fixture.existing_before)
            self.assertEqual((self.state / item["stage"]).stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)
        calls = list(self.fixture.calls)
        with self.journal() as manifest:
            run_pilot(manifest, self.source, self.target)
        self.assertEqual(self.fixture.calls[len(calls):], [("GET", BASE + "/capabilities", None)])

    def test_repeated_approved_pilot_never_expands_into_other_pending_sources(self):
        with self.journal() as manifest:
            approved = self.seed(manifest, 'approved-one')
            outside = self.seed(manifest, 'outside-approval')
            run_pilot(manifest, self.source, self.target, item_keys=[approved])
            run_pilot(manifest, self.source, self.target, item_keys=[approved])
            self.assertEqual(manifest.get(approved)['phase'], 'verified')
            self.assertEqual(manifest.get(outside)['phase'], 'discovered')
            self.assertIsNone(manifest.get(outside)['stage'])
            self.assertEqual(len(self.fixture.operations), 1)

    def test_foundation_precondition_is_not_reported_as_source_change(self):
        with self.journal() as manifest:
            self.seed(manifest)
            with patch.object(self.target.http, 'json', side_effect=Failure('remote_precondition_failed')):
                with self.assertRaisesRegex(Failure, 'foundation_capabilities_unavailable'):
                    run_pilot(manifest, self.source, self.target)
            self.assertEqual(self.fixture.calls, [])

    def cli_pilot_fixture(self, backup_state):
        with self.journal() as manifest:
            approved = self.seed(manifest, 'cli-approved')
            outside = self.seed(manifest, 'cli-outside')
            backup = {'state': backup_state, 'manifestDigest': manifest.snapshot_digest(),
                      'offHost': False, 'temporaryBackup': {'state': 'local_other_disk_verified',
                          'restoreMappingVerified': True, 'membersVerified': 20}}
            backup_path, approval_path = self.root / 'cli-backup.json', self.root / 'cli-approval.json'
            backup_path.write_bytes(canonical(backup))
            approval_path.write_bytes(canonical({'phase': 'bounded-pilot', 'approvedByOwner': True,
                'manifestDigest': manifest.snapshot_digest(), 'backupPlanDigest': digest(backup),
                'targetOrigin': self.fixture.origin, 'maxItems': 1, 'maxBytes': len(PNG), 'itemKeys': [approved]}))
            for path in [backup_path, approval_path]:
                path.chmod(0o600)
        config = {'stateDirectory': str(self.state), 'accountScope': 'synthetic',
                  'source': {'origin': self.fixture.origin, 'user': 'fixture', 'root': 'MyMind'},
                  'target': {'origin': self.fixture.origin}, 'backupPlanFile': str(backup_path)}
        args = ['--config', 'synthetic-config', 'pilot', '--limit', '1', '--max-bytes', str(len(PNG)),
                '--approval', str(approval_path)]
        return config, args, approved, outside

    def use_cli_namespace(self):
        self.namespace = {'accountScope': 'synthetic', 'sourceOrigin': self.fixture.origin,
                          'sourceUser': 'fixture', 'root': 'MyMind', 'targetOrigin': self.fixture.origin}

    def test_cli_declared_backup_fails_before_connections_with_otherwise_valid_approval(self):
        self.use_cli_namespace()
        config, args, approved, outside = self.cli_pilot_fixture('destination_declared_needs_snapshot_restore')
        with patch('migration_client.cli.load_config', return_value=config), \
                patch('migration_client.cli.connections', side_effect=AssertionError('must not connect')) as connections, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(args), 2)
        connections.assert_not_called()
        self.assertEqual(self.fixture.calls, [])
        with self.journal() as manifest:
            self.assertEqual(manifest.get(approved)['phase'], 'discovered')
            self.assertEqual(manifest.get(outside)['phase'], 'discovered')

    def test_cli_repeat_only_uses_exact_approved_keys(self):
        self.use_cli_namespace()
        config, args, approved, outside = self.cli_pilot_fixture('local_other_disk_verified')
        with patch('migration_client.cli.load_config', return_value=config), \
                patch('migration_client.cli.connections', return_value=(self.source, self.target)), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(args), 0)
            self.assertEqual(main(args), 0)
        self.assertEqual(len(self.fixture.operations), 1)
        with self.journal() as manifest:
            self.assertEqual(manifest.get(approved)['phase'], 'verified')
            self.assertEqual(manifest.get(outside)['phase'], 'discovered')
            self.assertIsNone(manifest.get(outside)['stage'])

    def test_crash_resume_every_checkpoint_has_one_operation_and_occurrence(self):
        for phase in ["after_stage", "after_reserve", "after_upload", "after_commit", "after_readback"]:
            with self.subTest(phase=phase):
                self.state = self.root / phase
                before = len(self.fixture.operations)
                def fault(point):
                    if point == phase:
                        raise Crash()
                with self.journal() as manifest:
                    key = self.seed(manifest, phase)
                    with self.assertRaises(Crash):
                        run_pilot(manifest, self.source, self.target, fault=fault)
                with self.journal() as manifest:
                    run_pilot(manifest, self.source, self.target)
                    self.assertEqual(manifest.get(key)["phase"], "verified")
                self.assertEqual(len(self.fixture.operations), before + 1)

    def test_reserve_reply_uncertainty_reuses_exact_transport_key_and_body(self):
        self.fixture.drop_once = ("POST", BASE + "/reservations")
        with self.journal() as manifest:
            key = self.seed(manifest)
            with self.assertRaises(Failure) as failure:
                run_pilot(manifest, self.source, self.target)
            self.assertTrue(failure.exception.retryable)
            self.assertIsNone(manifest.get(key)["hold"])
        with self.journal() as manifest:
            run_pilot(manifest, self.source, self.target)
            self.assertEqual(manifest.get(key)["phase"], "verified")
        keys = [key for method, path, key in self.fixture.calls if method == "POST" and path == BASE + "/reservations"]
        self.assertEqual(len(keys), 2)
        self.assertEqual(keys[0], keys[1])
        self.assertEqual(len(self.fixture.operations), 1)

    def test_commit_reply_uncertainty_reconciles_without_second_commit_or_upload(self):
        self.fixture.drop_once = ("POST", BASE + "/reservations/operation-1/commit")
        with self.journal() as manifest:
            key = self.seed(manifest)
            with self.assertRaises(Failure):
                run_pilot(manifest, self.source, self.target)
        initial_puts = sum(method == "PUT" for method, _, _ in self.fixture.calls)
        with self.journal() as manifest:
            run_pilot(manifest, self.source, self.target)
            self.assertEqual(manifest.get(key)["phase"], "verified")
        self.assertEqual(sum(path.endswith("/commit") for _, path, _ in self.fixture.calls), 1)
        self.assertEqual(sum(method == "PUT" for method, _, _ in self.fixture.calls), initial_puts)

    def test_interrupted_source_stage_does_not_promote_partial_and_resumes(self):
        self.fixture.source_truncate_once = True
        with self.journal() as manifest:
            key = self.seed(manifest)
            with self.assertRaises(Failure) as failure:
                run_pilot(manifest, self.source, self.target)
            self.assertTrue(failure.exception.retryable)
            self.assertFalse((manifest.root / "staging" / (key + ".original")).exists())
        with self.journal() as manifest:
            run_pilot(manifest, self.source, self.target)
            self.assertEqual(manifest.get(key)["phase"], "verified")
        self.assertEqual(len(self.fixture.operations), 1)

    def test_distinct_sources_same_bytes_get_distinct_assets_and_keep_metadata(self):
        self.fixture.content_matches = [{"assetId": "old-asset", "bookmarkId": "untouched"}]
        with self.journal() as manifest:
            first = self.seed(manifest, "one")
            doc = self.fixture.document("two")
            doc["metadata"]["originalRecord"]["title"] = "Different source title"
            second = manifest.seed(doc)
            run_pilot(manifest, self.source, self.target, limit=2)
            one, two = manifest.get(first), manifest.get(second)
            self.assertNotEqual(one["receipt"]["assets"][0]["assetId"], two["receipt"]["assets"][0]["assetId"])
            self.assertNotEqual(one["receipt"]["bookmarkId"], two["receipt"]["bookmarkId"])
        self.assertEqual(self.fixture.existing, self.fixture.existing_before)
        self.assertFalse(any("attach" in path or "delete" in path or "analyze" in path for _, path, _ in self.fixture.calls))

    def test_capabilities_fail_closed_before_any_source_request(self):
        self.fixture.materialize = False
        with self.journal() as manifest:
            self.seed(manifest)
            with self.assertRaisesRegex(Failure, "foundation_capabilities_unavailable"):
                run_pilot(manifest, self.source, self.target)
        self.assertEqual(self.fixture.calls, [("GET", BASE + "/capabilities", None)])

    def test_dry_run_has_no_get_media_or_target_mutations(self):
        with self.journal() as manifest:
            self.seed(manifest)
            report = dry_run(manifest, self.source, self.target)
            self.assertEqual(report["targetMutations"], 0)
            self.assertEqual(report["sourceBytesRead"], 0)
            self.assertEqual(manifest.summary()["phases"], {"discovered": 1})
        self.assertEqual([method for method, _, _ in self.fixture.calls], ["GET", "PROPFIND"])

    def test_etag_change_holds_before_upload(self):
        def change(*_):
            next(iter(self.fixture.files.values()))["etag"] = '"new-etag"'
        self.assert_hold("source_changed", change=change)
        self.assertFalse(self.fixture.operations)

    def test_fileid_change_holds_even_same_bytes_and_etag(self):
        def change(*_):
            next(iter(self.fixture.files.values()))["fileId"] = "101"
        self.assert_hold("source_changed", change=change)

    def test_source_hash_mismatch_holds_same_size_same_etag(self):
        def change(*_):
            file = next(iter(self.fixture.files.values()))
            file["bytes"] = file["bytes"][:-1] + b"X"
        self.assert_hold("source_bytes_mismatch", change=change)

    def test_unsupported_binary_held_in_verified_stage_without_upload(self):
        self.assert_hold("unsupported_source_format", body=b"8BPS" + b"synthetic PSD")
        self.assertFalse(self.fixture.operations)
        self.assertEqual(len(list((self.state / "staging").glob("*.original"))), 1)

    def test_target_original_corruption_is_not_verified(self):
        self.fixture.corrupt_original = True
        self.assert_hold("target_readback_mismatch")

    def test_target_metadata_corruption_is_not_verified(self):
        self.fixture.corrupt_metadata = True
        self.assert_hold("target_readback_mismatch")

    def test_target_display_mapping_error_is_not_verified(self):
        self.fixture.corrupt_mapping = True
        self.assert_hold("target_mapping_mismatch")

    def test_subsecond_source_timestamp_survives_exactly_in_metadata_and_payload(self):
        with self.journal() as manifest:
            doc = self.fixture.document('fractional-time')
            doc['metadata']['originalRecord']['created'] = '2021-03-30T10:13:53.743900Z'
            key = manifest.seed(doc)
            run_pilot(manifest, self.source, self.target)
            item = manifest.get(key)
            self.assertEqual(item['phase'], 'verified')
            op = self.fixture.operations[item['receipt']['operationId']]
            self.assertEqual(op['payload']['mapping']['savedAt'], '2021-03-30T10:13:53.743900Z')
            self.assertEqual(op['metadata'], canonical(doc))

    def test_wrong_projected_timestamp_second_is_not_verified(self):
        self.fixture.corrupt_date = True
        self.assert_hold('target_date_mapping_mismatch')

    def test_reconciliation_is_read_only_and_detects_later_target_loss(self):
        with self.journal() as manifest:
            key = self.seed(manifest)
            run_pilot(manifest, self.source, self.target)
        self.fixture.calls.clear()
        self.fixture.corrupt_original = True
        with self.journal() as manifest:
            result = reconcile(manifest, self.source, self.target)
            self.assertEqual(result["needsAttention"], {"target_readback_mismatch": 1})
            self.assertEqual(manifest.get(key)["hold"], "target_readback_mismatch")
        self.assertTrue(all(method in ("GET", "PROPFIND") for method, _, _ in self.fixture.calls))

    def test_staged_file_mutation_is_not_uploaded_on_resume(self):
        with self.journal() as manifest:
            key = self.seed(manifest)
            with self.assertRaises(Crash):
                run_pilot(manifest, self.source, self.target, fault=lambda point: (_ for _ in ()).throw(Crash()) if point == "after_stage" else None)
            (manifest.root / manifest.get(key)["stage"]).write_bytes(b"corrupt")
        with self.journal() as manifest:
            with self.assertRaisesRegex(Failure, "stored_bytes_mismatch"):
                run_pilot(manifest, self.source, self.target)
        self.assertFalse(self.fixture.operations)

    def test_budget_fails_before_staging_or_mutating(self):
        with self.journal() as manifest:
            self.seed(manifest)
            with self.assertRaisesRegex(Failure, "pilot_byte_limit"):
                run_pilot(manifest, self.source, self.target, max_bytes=1)
        self.assertEqual([method for method, _, _ in self.fixture.calls], ["GET"])

    def test_historical_and_diverged_items_do_not_enter_pilot(self):
        with self.journal() as manifest:
            doc = self.fixture.document()
            doc["revisionKind"] = "historical"
            key = manifest.seed(doc, "recovery_revision_needs_owner_review")
            run_pilot(manifest, self.source, self.target)
            self.assertEqual(manifest.get(key)["hold"], "recovery_revision_needs_owner_review")
        self.assertFalse(self.fixture.operations)

    def test_renewed_lease_fence_used_after_crash(self):
        with self.journal() as manifest:
            key = self.seed(manifest)
            with self.assertRaises(Crash):
                run_pilot(manifest, self.source, self.target, fault=lambda p: (_ for _ in ()).throw(Crash()) if p == "after_reserve" else None)
        self.fixture.fence = 2
        with self.journal() as manifest:
            run_pilot(manifest, self.source, self.target)
            self.assertEqual(manifest.get(key)["phase"], "verified")
        self.assertEqual(self.fixture.operations["operation-1"]["fencingToken"], 2)
        self.assertEqual(len(self.fixture.operations), 1)

    def test_metadata_locator_cannot_redirect_credentials(self):
        with self.journal() as manifest:
            key = self.seed(manifest)
            run_pilot(manifest, self.source, self.target)
            op = self.fixture.operations["operation-1"]
            receipt = copy.deepcopy(op["receipt"])
            receipt["metadataUrl"] = "https://outside.invalid/private"
            with self.assertRaisesRegex(Failure, "metadata_locator_mismatch"):
                self.target.readback(manifest, manifest.get(key), op["payload"], receipt)

    def test_source_edit_after_upload_blocks_commit(self):
        def change(point):
            if point == "after_upload":
                next(iter(self.fixture.files.values()))["etag"] = '"changed"'
        with self.journal() as manifest:
            key = self.seed(manifest)
            with self.assertRaisesRegex(Failure, "source_changed"):
                run_pilot(manifest, self.source, self.target, fault=change)
            self.assertEqual(manifest.get(key)["hold"], "source_changed")
        self.assertFalse(any(path.endswith("/commit") for _, path, _ in self.fixture.calls))

    def test_upload_reply_uncertainty_replays_same_immutable_slot(self):
        self.fixture.drop_once = ("PUT", BASE + "/reservations/operation-1/files/original")
        with self.journal() as manifest:
            key = self.seed(manifest)
            with self.assertRaises(Failure) as failure:
                run_pilot(manifest, self.source, self.target)
            self.assertTrue(failure.exception.retryable)
        with self.journal() as manifest:
            run_pilot(manifest, self.source, self.target)
            self.assertEqual(manifest.get(key)["phase"], "verified")
        self.assertEqual(len(self.fixture.operations), 1)
        self.assertEqual(self.fixture.operations["operation-1"]["original"], PNG)


class OfflineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_source_and_staging_path_containment(self):
        for path in ["MyMind/../secret", "/MyMind/file", "MyMind//file", "Elsewhere/file", "MyMind", "MyMind/Files/./image"]:
            with self.subTest(path=path), self.assertRaises(Failure):
                safe_source_path(path, "MyMind")
        with self.assertRaises(Failure):
            inside(self.root, "../secret")
        (self.root / "link").symlink_to(self.root / "elsewhere")
        with self.assertRaises(Failure):
            inside(self.root, "link")

    def test_manifest_single_writer_and_namespace_binding(self):
        with Manifest(self.root / "state", "one"):
            with self.assertRaisesRegex(Failure, "client_already_running"):
                with Manifest(self.root / "state", "one"):
                    pass
        with self.assertRaisesRegex(Failure, "manifest_configuration_changed"):
            with Manifest(self.root / "state", "different"):
                pass

    def test_operation_rejects_payload_change(self):
        with Manifest(self.root / "state", "one") as manifest:
            key = manifest.seed({"sourceObjectId": "fixture"})
            first = manifest.operation(key, "reserve", {"foo": "one"})
            self.assertEqual(first, manifest.operation(key, "reserve", {"foo": "one"}))
            with self.assertRaisesRegex(Failure, "operation_payload_changed"):
                manifest.operation(key, "reserve", {"foo": "two"})

    def test_config_denies_mac_before_any_network(self):
        path = self.root / "config.json"
        path.write_text('{}')
        path.chmod(0o600)
        with patch("migration_client.cli.platform.system", return_value="Darwin"):
            with self.assertRaisesRegex(Failure, "server_only_execution_required"):
                load_config(path)

    def test_backup_plan_never_claims_independence_from_staging(self):
        with Manifest(self.root / "state", "one") as manifest:
            manifest.seed({"sourceObjectId": "fixture", "observed": {"size": 10}})
            result = plan(manifest)
            self.assertEqual(result["state"], "destination_selection_required")
            self.assertFalse(result["independentBackupVerified"])
            self.assertEqual(result["networkCalls"], 0)

    def test_restore_verifies_real_bytes_and_sqlite_then_detects_corruption(self):
        restored = self.root / "restored"
        restored.mkdir()
        (restored / "original.bin").write_bytes(PNG)
        db = sqlite3.connect(restored / "source.sqlite")
        db.execute('CREATE TABLE objects(id TEXT PRIMARY KEY)')
        db.execute('INSERT INTO objects VALUES("fixture")')
        db.commit()
        db.close()
        members = []
        for name, kind in [("original.bin", "original"), ("source.sqlite", "sqlite")]:
            sha, size = file_hash(restored / name)
            members.append({"relativePath": name, "sha256": sha, "size": size, "kind": kind})
        spec = self.root / "spec.json"
        spec.write_bytes(canonical({"schemaVersion": 1, "members": members}))
        result = verify_restore(spec, restored, self.root / "receipt.json")
        self.assertTrue(result["memberBytesVerified"])
        self.assertEqual(result["verified"], 2)
        self.assertFalse(result["independentBackupVerified"])
        (restored / "original.bin").write_bytes(b"X" * len(PNG))
        result = verify_restore(spec, restored, self.root / "receipt.json")
        self.assertFalse(result["memberBytesVerified"])
        self.assertEqual(result["mismatched"], 1)

    def test_restore_rejects_path_escape(self):
        spec = self.root / "spec.json"
        spec.write_bytes(canonical({"schemaVersion": 1, "members": [{"relativePath": "../outside"}]}))
        with self.assertRaises(Failure):
            verify_restore(spec, self.root, self.root / "receipt.json")

    def test_missing_pilot_approval_blocks_before_network(self):
        with Manifest(self.root / "state", "one") as manifest:
            with self.assertRaisesRegex(Failure, "concrete_pilot_approval_required"):
                pilot_approval(manifest, {}, None, 1, 1)

    def test_cached_seed_is_idempotent_keeps_unknown_metadata_and_held_revisions(self):
        audit = self.root / 'audit'
        (audit / 'recovery-staging').mkdir(parents=True)
        database = self.root / 'source.sqlite'
        db = sqlite3.connect(database)
        db.execute('CREATE TABLE objects(object_id TEXT PRIMARY KEY,remote_path TEXT,status TEXT,sha256 TEXT,size INTEGER,title TEXT,created TEXT,modified TEXT,tags TEXT)')
        inventory, verification, recovery = [], [], []
        for n in range(3):
            path = f'MyMind/Files/{n}.json'
            original = f'synthetic export {n}'.encode()
            current = original if n == 0 else f'synthetic changed {n}'.encode()
            exported_sha = hashlib.sha256(original).hexdigest()
            current_sha = hashlib.sha256(current).hexdigest()
            object_id = 'fixture-' + str(n)
            db.execute('INSERT INTO objects VALUES(?,?,?,?,?,?,?,?,?)',
                       (object_id, path, 'done', exported_sha, len(original), 'Title',
                        '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z', '["one"]'))
            inventory.append({'path': path, 'size': len(current), 'properties': {
                '{DAV:}getetag': '"etag-' + str(n) + '"', '{http://owncloud.org/ns}fileid': str(n)}})
            verification.append({'path': path, 'http_status': 200, 'sha256': current_sha, 'bytes': len(current)})
            if n:
                for revision, sha, size in [('current', current_sha, len(current)), ('historical-version', exported_sha, len(original))]:
                    recovery.append({'source_object_id': object_id, 'original_path': path,
                        'revision': revision, 'source_fileid': str(n), 'response_etag': '"recovery"',
                        'source_version_id': str(n) if revision.startswith('historical') else None,
                        'sha256': sha, 'size': size, 'source_metadata': {'sha256': exported_sha, 'size': len(original)}})
        db.commit()
        db.close()
        before = file_hash(database)
        for name, records in [('source-inventory.jsonl', inventory), ('source-byte-verification.jsonl', verification),
                              ('recovery-staging/manifest.jsonl', recovery)]:
            (audit / name).write_bytes(b''.join(canonical(r) + b'\n' for r in records))
        with Manifest(self.root / 'state', 'synthetic') as manifest:
            result = seed_audit(manifest, audit, database, 'fixture-account', 'MyMind')
            self.assertEqual(result['items'], 7)
            self.assertEqual(result['holds'], {'source_revision_diverged': 2, 'recovery_revision_needs_owner_review': 4})
            one = manifest.items(1)[0]
            self.assertEqual(one['document']['metadata']['available']['sourceUrl'], 'not_exported')
            self.assertEqual(one['document']['upstreamCompleteness'], 'unknown')
            self.assertEqual(seed_audit(manifest, audit, database, 'fixture-account', 'MyMind'), result)
            with (audit / 'source-inventory.jsonl').open('ab') as output:
                output.write(canonical(inventory[0]) + b'\n')
            with self.assertRaisesRegex(Failure, 'cached_source_path_duplicated'):
                seed_audit(manifest, audit, database, 'fixture-account', 'MyMind')
        self.assertEqual(file_hash(database), before)


if __name__ == "__main__":
    unittest.main()
