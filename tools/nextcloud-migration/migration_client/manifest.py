import contextlib
import fcntl
import json
import os
import sqlite3
import time

from .core import Failure, canonical, digest, private_dir


class Manifest:
    """Client-owned journal, separate from both sync.db and Karakeep's schema."""

    def __init__(self, directory, namespace):
        self.root = private_dir(directory)
        self.namespace = namespace
        self.connection = None
        self.lock = None

    def __enter__(self):
        lock_path = self.root / "client.lock"
        if lock_path.is_symlink():
            raise Failure("symlink_state_file")
        self.lock = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(self.lock)
            self.lock = None
            raise Failure("client_already_running", retryable=True) from None
        try:
            path = self.root / "manifest.sqlite"
            if path.is_symlink():
                raise Failure("symlink_state_file")
            fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
            os.close(fd)
            if path.stat().st_mode & 0o077:
                raise Failure("state_file_not_private")
            self.connection = sqlite3.connect(path)
            self.connection.row_factory = sqlite3.Row
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.connection.execute("PRAGMA synchronous=FULL")
            self.connection.execute("PRAGMA foreign_keys=ON")
            self.connection.executescript('''
              CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS items(
                key TEXT PRIMARY KEY, revision TEXT NOT NULL,
                document TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'discovered',
                hold TEXT, stage TEXT, mime TEXT, receipt TEXT, error TEXT,
                last_checked REAL NOT NULL DEFAULT 0,
                UNIQUE(revision));
              CREATE TABLE IF NOT EXISTS operations(
                item_key TEXT NOT NULL REFERENCES items(key), name TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE, payload_digest TEXT NOT NULL,
                response TEXT, PRIMARY KEY(item_key,name));
              CREATE TABLE IF NOT EXISTS events(
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                item_key TEXT REFERENCES items(key), timestamp REAL NOT NULL,
                code TEXT NOT NULL);
            ''')
            self.bind("schema_version", 1)
            self.bind("namespace", self.namespace)
            return self
        except Exception:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        if self.connection:
            self.connection.close()
            self.connection = None
        if self.lock is not None:
            os.close(self.lock)
            self.lock = None

    def bind(self, name, value):
        encoded = canonical(value).decode()
        with self.connection:
            row = self.connection.execute("SELECT value FROM settings WHERE key=?", (name,)).fetchone()
            if row and row[0] != encoded:
                raise Failure("manifest_configuration_changed")
            self.connection.execute("INSERT OR IGNORE INTO settings VALUES(?,?)", (name, encoded))

    def seed(self, document, hold=None):
        revision = digest(document)
        key = digest([self.namespace, document["sourceObjectId"], revision])
        encoded = canonical(document).decode()
        with self.connection:
            self.connection.execute(
                "INSERT OR IGNORE INTO items(key,revision,document,hold) VALUES(?,?,?,?)",
                (key, revision, encoded, hold))
        return key

    def get(self, key):
        row = self.connection.execute("SELECT * FROM items WHERE key=?", (key,)).fetchone()
        if row is None:
            raise Failure("item_missing")
        value = dict(row)
        value["document"] = json.loads(value["document"])
        value["receipt"] = json.loads(value["receipt"]) if value["receipt"] else None
        return value

    def items(self, limit=12, include_held=False):
        if type(limit) is not int or not 1 <= limit <= 12:
            raise Failure("pilot_item_limit")
        clause = "" if include_held else "WHERE hold IS NULL AND phase != 'verified'"
        return [self.get(r[0]) for r in self.connection.execute(
            f"SELECT key FROM items {clause} ORDER BY key LIMIT ?", (limit,))]

    def update(self, key, **fields):
        if not fields or not set(fields) <= {"phase", "hold", "stage", "mime", "receipt", "error", "last_checked"}:
            raise ValueError("Invalid manifest update fields")
        if "receipt" in fields:
            fields["receipt"] = canonical(fields["receipt"]).decode()
        with self.connection:
            self.connection.execute("UPDATE items SET " + ",".join(k + "=?" for k in fields) + " WHERE key=?",
                                    (*fields.values(), key))

    def event(self, key, code):
        with self.connection:
            self.connection.execute("INSERT INTO events(item_key,timestamp,code) VALUES(?,?,?)",
                                    (key, time.time(), code))

    def operation(self, key, name, payload):
        payload_digest = digest(payload)
        idem = digest([self.namespace, key, name, payload_digest])
        with self.connection:
            self.connection.execute("INSERT OR IGNORE INTO operations VALUES(?,?,?,?,NULL)",
                                    (key, name, idem, payload_digest))
            row = self.connection.execute("SELECT * FROM operations WHERE item_key=? AND name=?",
                                          (key, name)).fetchone()
            if row["payload_digest"] != payload_digest:
                raise Failure("operation_payload_changed")
        return dict(row)

    def record_response(self, key, name, response):
        with self.connection:
            self.connection.execute("UPDATE operations SET response=? WHERE item_key=? AND name=?",
                                    (canonical(response).decode(), key, name))

    def pace_write(self, minimum_gap):
        if not 0 <= minimum_gap <= 10:
            raise Failure("invalid_write_interval")
        row = self.connection.execute("SELECT value FROM settings WHERE key='last_target_write'").fetchone()
        previous = float(row[0]) if row else 0
        # Clock skew cannot induce an unbounded sleep. A process lock serializes clients.
        delay = min(minimum_gap, max(0, previous + minimum_gap - time.time()))
        if delay:
            time.sleep(delay)
        with self.connection:
            self.connection.execute("INSERT INTO settings VALUES('last_target_write',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                                    (str(time.time()),))

    def snapshot_digest(self):
        records = self.connection.execute("SELECT key,revision FROM items ORDER BY key").fetchall()
        return digest([list(r) for r in records])

    def reconciliation_items(self, limit):
        if type(limit) is not int or not 1 <= limit <= 12:
            raise Failure("pilot_item_limit")
        return [self.get(r[0]) for r in self.connection.execute(
            "SELECT key FROM items WHERE receipt IS NOT NULL ORDER BY last_checked,key LIMIT ?", (limit,))]

    def summary(self):
        def count(column):
            return {r[0]: r[1] for r in self.connection.execute(
                f"SELECT {column},count(*) FROM items WHERE {column} IS NOT NULL GROUP BY {column}")}
        return {"items": self.connection.execute("SELECT count(*) FROM items").fetchone()[0],
                "phases": count("phase"), "holds": count("hold"), "errors": count("error"),
                "cleanupImplemented": False, "processingReleaseImplemented": False}

    def backup_database(self, path):
        # Consistent SQLite backup, never raw-copy a live WAL database.
        with contextlib.closing(sqlite3.connect(path)) as backup:
            self.connection.backup(backup)
            if backup.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise Failure("backup_sqlite_integrity")
        os.chmod(path, 0o600)
