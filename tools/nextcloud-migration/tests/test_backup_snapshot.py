import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest

from backup_snapshot import finalize_snapshot, sha_file
from migration_client.backup import plan
from migration_client.cli import pilot_approval
from migration_client.core import Failure, canonical, digest
from migration_client.manifest import Manifest


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.snapshot = self.root / 'snapshot'
        self.restore = self.root / 'restore'
        for root in [self.snapshot, self.restore]:
            for name in ['originals', 'metadata', 'recovery']:
                (root / name).mkdir(parents=True)
        self.docs = []
        (self.restore / 'restore-receipt.json').write_text('{"members":[]}')
        original = self.snapshot / 'originals/000001.bin'
        original.write_bytes(b'synthetic original')
        sha, size = sha_file(original)
        self.docs.append({'sourceObjectId': 'original-one', 'path': 'MyMind/Files/one.png',
                          'revisionKind': 'current', 'observed': {'sha256': sha, 'size': size}})
        db = sqlite3.connect(self.snapshot / 'checkpoint.sqlite')
        db.execute('CREATE TABLE files(n INTEGER PRIMARY KEY,source_path TEXT,source_id TEXT,etag TEXT,file_id TEXT,sha256 TEXT,size INTEGER,exported_sha256 TEXT,exported_size INTEGER,destination TEXT,state TEXT,error TEXT)')
        db.execute('CREATE TABLE local_members(relative_path TEXT PRIMARY KEY,sha256 TEXT,size INTEGER,kind TEXT)')
        db.execute('INSERT INTO files VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
                   (1, 'MyMind/Files/one.png', 'original-one', '"synthetic"', '100', sha, size,
                    sha, size, 'originals/000001.bin', 'verified', None))
        records = []
        for n in range(1, 5):
            path = self.snapshot / f'recovery/{n:06d}.bin'
            path.write_bytes(f'synthetic preserved revision {n}'.encode())
            sha, size = sha_file(path)
            record = {'source_object_id': 'recovery-' + str(n), 'original_path': f'MyMind/Files/{n}.json',
                      'revision': 'historical-version' if n % 2 else 'current',
                      'source_version_id': str(n) if n % 2 else None, 'source_fileid': str(n),
                      'response_etag': '"synthetic-recovery"', 'sha256': sha, 'size': size,
                      'source_metadata': {'sha256': sha, 'size': size},
                      'detected_content_type': 'image/png',
                      'stage_path': '/missing/former/appdata/private-stage.bin'}
            records.append(record)
            self.docs.append({'sourceObjectId': record['source_object_id'], 'path': record['original_path'],
                              'revisionKind': 'historical' if n % 2 else 'current',
                              'observed': {'sha256': sha, 'size': size}, 'preservedRevision': record['revision']})
            shutil.copyfile(path, self.restore / f'recovery/{n:06d}.bin')
        provenance = self.snapshot / 'metadata/recovery-manifest.jsonl'
        provenance.write_bytes(b''.join(canonical(r) + b'\n' for r in records))
        self.provenance_bytes = provenance.read_bytes()
        source_db = sqlite3.connect(self.snapshot / 'metadata/source-sync.sqlite')
        source_db.execute('CREATE TABLE objects(object_id TEXT PRIMARY KEY)')
        source_db.execute('INSERT INTO objects VALUES("synthetic")')
        source_db.commit()
        source_db.close()
        for path in [provenance, self.snapshot / 'metadata/source-sync.sqlite', *sorted((self.snapshot / 'recovery').iterdir())]:
            sha, size = sha_file(path)
            db.execute('INSERT INTO local_members VALUES(?,?,?,?)',
                       (str(path.relative_to(self.snapshot)), sha, size, 'metadata'))
        db.commit()
        db.close()
        (self.snapshot / 'snapshot.json').write_text('{"offHost":false}')
        (self.snapshot / 'summary.json').write_bytes(canonical({
            'state': 'local_other_disk_verified', 'currentFiles': 1,
            'offHost': False, 'survivesHomeserverLoss': False,
            'restoredSqliteIntegrity': 'ok', 'restoredMembersVerified': 4,
            'restoreDirectory': str(self.restore)}))

    def tearDown(self):
        self.temp.cleanup()

    def test_finalization_restores_explicit_mapping_without_old_stage(self):
        result = finalize_snapshot(self.snapshot)
        self.assertTrue(result['allSpecMembersReadbackVerified'])
        self.assertEqual(result['restoredMappingRecoveryByteChecks'], 4)
        self.assertFalse(result['offHost'])
        self.assertEqual((self.snapshot / 'metadata/recovery-manifest.jsonl').read_bytes(), self.provenance_bytes)
        records = [json.loads(line) for line in (self.restore / 'metadata/restore-map.jsonl').read_bytes().splitlines()]
        self.assertEqual(len(records), 5)
        self.assertNotIn('stage_path', records[-1])
        self.assertEqual(records[-1]['backupRelativePath'], 'recovery/000004.bin')
        spec = json.loads((self.snapshot / 'restore-spec.json').read_bytes())
        self.assertIn('RESTORE.md', [m['relativePath'] for m in spec['members']])

    def test_wrong_recovery_association_fails_before_writing_restore_map(self):
        (self.snapshot / 'recovery/000001.bin').write_bytes(b'wrong source revision')
        with self.assertRaisesRegex(RuntimeError, 'recovery_restore_mapping_hash_mismatch'):
            finalize_snapshot(self.snapshot)
        self.assertFalse((self.snapshot / 'metadata/restore-map.jsonl').exists())

    def test_verified_temporary_backup_allows_separately_approved_copy_pilot(self):
        finalize_snapshot(self.snapshot)
        destination = {'ownerApproved': True, 'kind': 'local_other_disk',
                       'separatePhysicalDisk': True, 'snapshotDirectory': str(self.snapshot)}
        with Manifest(self.root / 'client', 'synthetic') as manifest:
            keys = [manifest.seed(doc) for doc in self.docs]
            result = plan(manifest, destination)
            self.assertEqual(result['state'], 'local_other_disk_verified')
            self.assertFalse(result['independentBackupVerified'])
            self.assertFalse(result['offHost'])
            backup_path, approval_path = self.root / 'backup.json', self.root / 'approval.json'
            backup_path.write_bytes(canonical(result))
            approval_path.write_bytes(canonical({'phase': 'bounded-pilot',
                'manifestDigest': manifest.snapshot_digest(), 'targetOrigin': 'http://synthetic.invalid',
                'backupPlanDigest': digest(result), 'approvedByOwner': True, 'maxItems': 1, 'maxBytes': 1000,
                'itemKeys': [keys[0]]}))
            for path in [backup_path, approval_path]:
                path.chmod(0o600)
            config = {'backupPlanFile': str(backup_path), 'target': {'origin': 'http://synthetic.invalid'}}
            self.assertEqual(pilot_approval(manifest, config, str(approval_path), 1, 1000), [keys[0]])
            with self.assertRaises(Failure):
                pilot_approval(manifest, config, str(approval_path), 2, 1000)
            (self.snapshot / 'originals/000001.bin').write_bytes(b'corrupted backup')
            with self.assertRaisesRegex(Failure, 'temporary_backup_readback_failed'):
                plan(manifest, destination)


if __name__ == '__main__':
    unittest.main()
