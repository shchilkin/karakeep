import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch

import poll


class IdleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.data = self.root / 'data'
        self.data.mkdir()
        self.addCleanup(patch.stopall)
        patch.object(poll, 'ROOT', self.root).start()
        patch.object(poll, 'DATA', self.data).start()
        with sqlite3.connect(self.data / 'db.db') as db:
            db.executescript('''
              CREATE TABLE bookmarks(id TEXT PRIMARY KEY,processingPolicy TEXT,mediaAi TEXT,
                userId TEXT DEFAULT 'owner',policyRevision INTEGER DEFAULT 0,contentRevision INTEGER DEFAULT 0);
              CREATE TABLE importProcessing(bookmarkId TEXT PRIMARY KEY,stage TEXT,state TEXT,
                aiRunId TEXT,leaseToken TEXT,leaseUntil INTEGER,error TEXT,
                userId TEXT DEFAULT 'owner',policyRevision INTEGER DEFAULT 0,contentRevision INTEGER DEFAULT 0,
                searchRevision INTEGER DEFAULT 0,searchIndexedRevision INTEGER DEFAULT 0);
              CREATE TABLE mediaAiRequests(id TEXT PRIMARY KEY,bookmarkId TEXT,userId TEXT,day TEXT);
              CREATE TABLE mediaAiBatches(status TEXT,entries TEXT);
            ''')
        with sqlite3.connect(self.data / 'queue.db') as db:
            db.execute('CREATE TABLE tasks(queue TEXT,status TEXT,payload TEXT)')
        sidecar = self.root / 'social-enricher/state'
        sidecar.mkdir(parents=True)
        with sqlite3.connect(sidecar / 'jobs.sqlite3') as db:
            db.execute('CREATE TABLE jobs(status TEXT)')

    def orphan(self):
        with sqlite3.connect(self.data / 'db.db') as db:
            db.execute('INSERT OR REPLACE INTO bookmarks(id,processingPolicy,mediaAi) VALUES(?,?,?)',
                       ('one','deferred',json.dumps(dict(
                           runId='run-one',status='pending',localOnly=True,classificationOnly=True))))
            db.execute('INSERT INTO importProcessing(bookmarkId,stage,state,aiRunId,leaseUntil) VALUES(?,?,?,?,?)',
                       ('one','local_check','failed','run-one',0))

    def execute(self, sql, values=(), database='db.db'):
        with sqlite3.connect(self.data / database) as db:
            db.execute(sql, values)

    def snapshot(self):
        with sqlite3.connect(self.data / 'db.db') as db:
            return list(db.iterdump())

    def test_failed_local_import_without_a_job_does_not_block_deployment(self):
        self.orphan()
        before = self.snapshot()
        self.assertTrue(poll.idle())
        self.assertEqual(self.snapshot(), before)

    def test_a_task_blocks_even_with_an_orphaned_snapshot(self):
        self.orphan()
        for status in ('pending','running','delayed','failed'):
            with self.subTest(status=status):
                self.execute('INSERT INTO tasks VALUES(?,?,?)',
                             ('media_catalog_queue',status,'{}'), 'queue.db')
                self.assertFalse(poll.idle())
                self.execute('DELETE FROM tasks', database='queue.db')

    def test_paid_pending_is_never_ignored(self):
        self.orphan()
        self.execute('INSERT INTO mediaAiRequests(id) VALUES(?)', ('run-one',))
        self.assertFalse(poll.idle())

    def test_unrelated_paid_history_does_not_block(self):
        self.orphan()
        self.execute('INSERT INTO mediaAiRequests(id) VALUES(?)', ('another-run',))
        self.assertTrue(poll.idle())

    def test_another_active_bookmark_still_blocks(self):
        self.orphan()
        self.execute('INSERT INTO bookmarks(id,processingPolicy,mediaAi) VALUES(?,?,?)',
                     ('two','automatic','{"runId":"run-two","status":"pending"}'))
        self.assertFalse(poll.idle())

    def test_orphan_exception_requires_exact_free_pending_state(self):
        self.orphan()
        for patch_ai in ({'status':'checking_local'}, {'status':'processing'},
                         {'status':'processing_local'}, {'status':'waiting_resource'},
                         {'status':'waiting_control'}, {'classificationOnly':False},
                         {'localOnly':False}, {'runId':'new-run'}, {'runId':None},
                         {'localRecheckRequested':True}):
            with self.subTest(patch_ai=patch_ai):
                state = dict(runId='run-one',status='pending',classificationOnly=True,localOnly=True)
                state.update(patch_ai)
                self.execute('UPDATE bookmarks SET mediaAi=?', (json.dumps(state),))
                self.assertFalse(poll.idle())

    def test_orphan_exception_requires_exact_failed_import(self):
        self.orphan()
        variants = (('stage','catalog'),('state','waiting_ai'),('state','complete'),
                    ('state','held'),('leaseToken','old-lease'),('leaseUntil',1),
                    ('aiRunId','new-run'),('userId','other'),('policyRevision',1),
                    ('contentRevision',1))
        for column, value in variants:
            with self.subTest(column=column,value=value):
                with sqlite3.connect(self.data / 'db.db') as db:
                    previous = db.execute(f'SELECT {column} FROM importProcessing').fetchone()[0]
                self.execute(f'UPDATE importProcessing SET {column}=?', (value,))
                self.assertFalse(poll.idle())
                self.execute(f'UPDATE importProcessing SET {column}=?', (previous,))
        self.execute("UPDATE bookmarks SET processingPolicy='automatic'")
        self.assertFalse(poll.idle())

    def test_import_work_blocks_without_any_ai_snapshot(self):
        self.orphan()
        self.execute('UPDATE bookmarks SET mediaAi=NULL')
        for state in ('queued','running','waiting_ai'):
            with self.subTest(state=state):
                self.execute('UPDATE importProcessing SET state=?', (state,))
                self.assertFalse(poll.idle())
        self.execute("UPDATE importProcessing SET state='held',leaseUntil=?", (int(time.time()*1000)+60_000,))
        self.assertFalse(poll.idle())
        self.execute("UPDATE importProcessing SET state='complete',leaseUntil=0,searchRevision=2,searchIndexedRevision=1")
        self.assertFalse(poll.idle())
        self.execute('UPDATE importProcessing SET searchIndexedRevision=searchRevision')
        self.assertTrue(poll.idle())

    def test_running_batch_waits_for_admission(self):
        for status in ('ready','queued'):
            with self.subTest(status=status):
                self.execute('INSERT INTO mediaAiBatches VALUES(?,?)', ('running',json.dumps([{'status':status}])))
                self.assertFalse(poll.idle())
                self.execute('DELETE FROM mediaAiBatches')
        self.execute('INSERT INTO mediaAiBatches VALUES(?,?)', ('paused','[{"status":"ready"}]'))
        self.assertTrue(poll.idle())

    def test_sidecar_work_blocks(self):
        with sqlite3.connect(self.root / 'social-enricher/state/jobs.sqlite3') as db:
            db.execute("INSERT INTO jobs VALUES('processing')")
        self.assertFalse(poll.idle())

    def test_missing_queue_or_schema_fails_closed(self):
        self.assertTrue(poll.idle())
        (self.data / 'queue.db').unlink()
        with self.assertRaises(sqlite3.OperationalError):
            poll.idle()
        self.assertFalse((self.data / 'queue.db').exists())
        self.execute('DROP TABLE importProcessing')
        with self.assertRaises(sqlite3.OperationalError):
            poll.idle()


if __name__ == '__main__':
    unittest.main()
