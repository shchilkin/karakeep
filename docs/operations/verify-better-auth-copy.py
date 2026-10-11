#!/usr/bin/env python3
"""Read-only verification of Karakeep 0105 against a pristine SQLite backup.

Never prints row values, passwords, tokens or email addresses.
Usage: python3 verify-better-auth-copy.py BEFORE AFTER SOURCE_DRIZZLE_DIR
"""
import hashlib
import json
import sqlite3
import sys
from pathlib import Path


def connect(path):
    connection = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def quoted(name):
    return '"' + name.replace('"', '""') + '"'


def tables(connection):
    return {row[0] for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}


def digest(connection, table):
    hashes = []
    for row in connection.execute('SELECT * FROM ' + quoted(table)):
        values = [({'blob': value.hex()} if isinstance(value, bytes) else value) for value in row]
        hashes.append(hashlib.sha256(json.dumps(values, ensure_ascii=True, separators=(',', ':')).encode()).digest())
    return {'rows': len(hashes), 'sha256': hashlib.sha256(b''.join(sorted(hashes))).hexdigest()}


def fingerprint(connection):
    return {table: digest(connection, table) for table in sorted(tables(connection))}


def verify(before, after, migrations):
    old, new = connect(before), connect(after)
    for db in (old, new):
        assert [row[0] for row in db.execute('PRAGMA integrity_check')] == ['ok'], 'integrity_check'
        assert not list(db.execute('PRAGMA foreign_key_check')), 'foreign_key_check'
    changed = {'user', 'account', 'session', 'verificationToken', 'passwordResetToken', '__drizzle_migrations'}
    assert tables(new) == tables(old) - {'passwordResetToken'}, 'table set'
    unchanged = {}
    for table in sorted(tables(old) - changed):
        assert [tuple(r) for r in old.execute('PRAGMA table_info(' + quoted(table) + ')')] == [tuple(r) for r in new.execute('PRAGMA table_info(' + quoted(table) + ')')], 'columns: ' + table
        previous = digest(old, table)
        assert previous == digest(new, table), 'data changed: ' + table
        unchanged[table] = previous
    old_users = {r['id']: dict(r) for r in old.execute('SELECT * FROM user')}
    new_users = {r['id']: dict(r) for r in new.execute('SELECT * FROM user')}
    assert old_users.keys() == new_users.keys(), 'user IDs'
    credential_count = 0
    for user_id, previous in old_users.items():
        current = new_users[user_id]
        expected = {k: v for k, v in previous.items() if k not in ('password', 'salt')}
        collision = old.execute('SELECT count(*) FROM user WHERE lower(email)=lower(?) AND id!=?', (previous['email'], user_id)).fetchone()[0]
        expected['email'] = previous['email'] if collision else old.execute('SELECT lower(?)', (previous['email'],)).fetchone()[0]
        expected['emailVerified'] = int(previous['emailVerified'] is not None)
        assert current['createdAt'] > 0 and current['updatedAt'] == current['createdAt'], 'user timestamps'
        assert {k: v for k, v in current.items() if k not in ('createdAt', 'updatedAt')} == expected, 'user mapping'
        if previous['password'] is not None:
            credential_count += 1
            account = new.execute("SELECT * FROM account WHERE id=?", ('legacy-credential:' + user_id,)).fetchone()
            assert account is not None, 'credential missing'
            assert account['userId'] == user_id and account['accountId'] == user_id and account['providerId'] == 'credential', 'credential identity'
            expected_hash = previous['password'] if previous['salt'] == '' else 'bcrypt-salted:' + previous['salt'] + ':' + previous['password']
            assert account['password'] == expected_hash, 'legacy hash conversion'
    oauth_count = 0
    for account in old.execute('SELECT * FROM account'):
        if account['userId'] not in old_users:
            continue
        oauth_count += 1
        current = new.execute('SELECT * FROM account WHERE id=?', ('legacy-oauth:' + account['provider'] + ':' + account['providerAccountId'],)).fetchone()
        assert current is not None, 'OAuth account missing'
        mappings = {'accountId':'providerAccountId', 'providerId':'provider', 'userId':'userId', 'accessToken':'access_token', 'refreshToken':'refresh_token', 'idToken':'id_token', 'scope':'scope'}
        assert all(current[k] == account[v] for k, v in mappings.items()), 'OAuth mapping'
        assert current['accessTokenExpiresAt'] == (None if account['expires_at'] is None else account['expires_at'] * 1000), 'OAuth expiry'
    assert new.execute('SELECT count(*) FROM account').fetchone()[0] == credential_count + oauth_count, 'account count'
    for table in ('session', 'verificationToken'):
        assert new.execute('SELECT count(*) FROM ' + quoted(table)).fetchone()[0] == 0, 'old auth tokens not invalidated'
    old_ledger = [tuple(r) for r in old.execute('SELECT * FROM __drizzle_migrations ORDER BY created_at')]
    new_ledger = [tuple(r) for r in new.execute('SELECT * FROM __drizzle_migrations ORDER BY created_at')]
    assert len(new_ledger) == len(old_ledger) + 1 and new_ledger[:-1] == old_ledger, 'migration history'
    migrations = Path(migrations)
    expected_hash = hashlib.sha256((migrations/'0105_migrate_to_better_auth.sql').read_bytes()).hexdigest()
    journal = json.loads((migrations/'meta/_journal.json').read_text())
    entry = next(e for e in journal['entries'] if e['tag'] == '0105_migrate_to_better_auth')
    assert new_ledger[-1][1:] == (expected_hash, entry['when']), 'unexpected appended migration'
    return {'integrity': 'ok', 'foreign_keys': 'ok', 'unchanged_tables': unchanged, 'users': len(old_users), 'credential_accounts': credential_count, 'oauth_accounts': oauth_count, 'sessions_invalidated': True, 'verification_tokens_invalidated': True, 'password_reset_table_removed': True, 'migration_count_before': len(old_ledger), 'migration_count_after': len(new_ledger), 'migration_sha256': expected_hash}


if __name__ == '__main__':
    print(json.dumps(verify(*sys.argv[1:]), indent=2))
