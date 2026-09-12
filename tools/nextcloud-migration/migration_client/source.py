import hashlib
import json
import os
import shutil
import sqlite3
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from .core import (Failure, atomic_write, byte_size, canonical, check_file, hash_string,
                   inside, private_dir, sniff, sync_directory)
from .http import chunks


def safe_source_path(path, root):
    if not isinstance(path, str) or any(part in ("", ".", "..") for part in path.split("/")):
        raise Failure("invalid_source_path")
    if path == root or not path.startswith(root + "/") or "\x00" in path or "\\" in path:
        raise Failure("source_path_outside_root")
    return path


def jsonl(path, max_records=20_000):
    with Path(path).open("rb") as source:
        for number, line in enumerate(source, 1):
            if number > max_records or len(line) > 4 * 1024 * 1024:
                raise Failure("cached_manifest_limit")
            try:
                yield json.loads(line)
            except (ValueError, UnicodeError):
                raise Failure("invalid_cached_manifest") from None


def seed_audit(manifest, audit_directory, sync_database, account, root):
    """Reads existing private evidence only. No live enumeration or mymind API."""
    audit = Path(audit_directory)
    inventory_records = list(jsonl(audit / "source-inventory.jsonl"))
    verified_records = list(jsonl(audit / "source-byte-verification.jsonl"))
    inventory = {r["path"]: r for r in inventory_records}
    verified = {r["path"]: r for r in verified_records}
    if len(inventory) != len(inventory_records) or len(verified) != len(verified_records):
        raise Failure("cached_source_path_duplicated")
    database_uri = Path(sync_database).resolve().as_uri() + "?mode=ro"
    db = sqlite3.connect(database_uri, uri=True)
    db.row_factory = sqlite3.Row
    try:
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise Failure("source_database_integrity")
        rows = db.execute("SELECT * FROM objects ORDER BY object_id LIMIT 20001").fetchall()
        if len(rows) > 20000:
            raise Failure("cached_manifest_limit")
        paths = [r["remote_path"] for r in rows]
        if len(set(paths)) != len(paths) or set(paths) != set(inventory) or set(paths) != set(verified):
            raise Failure("cached_source_scope_mismatch")
        for row in rows:
            raw = dict(row)
            path = safe_source_path(raw["remote_path"], root)
            if path not in inventory or path not in verified:
                raise Failure("cached_evidence_incomplete")
            inv, verification = inventory[path], verified[path]
            props = inv["properties"]
            observed = {"sha256": hash_string(verification["sha256"]),
                        "size": byte_size(verification["bytes"])}
            if observed["size"] != inv["size"]:
                raise Failure("cached_source_size_mismatch")
            exported = {"sha256": hash_string(raw["sha256"]), "size": byte_size(raw["size"])}
            document = {
                "provider": "mymind", "transportProvider": "nextcloud-webdav",
                "accountScope": account, "sourceObjectId": raw["object_id"],
                "revisionKind": "current", "path": path,
                "fileId": props.get("{http://owncloud.org/ns}fileid"),
                "etag": props.get("{DAV:}getetag"), "observed": observed, "exported": exported,
                "metadata": {"originalRecord": raw, "nextcloudProperties": props,
                             "available": {"title": "present" if raw.get("title") else "empty",
                                           "created": "present" if raw.get("created") else "unknown",
                                           "modified": "present" if raw.get("modified") else "unknown",
                                           "sourceUrl": "not_exported", "note": "not_exported",
                                           "collections": "not_exported", "carousel": "unknown"}},
                "upstreamCompleteness": "unknown", "knownExportedSlots": ["original"],
            }
            hold = None
            if raw["status"] != "done" or verification.get("http_status") != 200:
                hold = "source_not_verified"
            elif observed != exported:
                hold = "source_revision_diverged"
            elif not document["fileId"] or not document["etag"]:
                hold = "source_identity_incomplete"
            manifest.seed(document, hold)
    finally:
        db.close()
    recovery = audit / "recovery-staging" / "manifest.jsonl"
    if recovery.exists():
        for record in jsonl(recovery):
            # Current and historical preserved as their own held evidence revisions.
            document = {
                "provider": "mymind", "transportProvider": "nextcloud-webdav",
                "accountScope": account, "sourceObjectId": record["source_object_id"],
                "revisionKind": "historical" if record["revision"].startswith("historical") else "current",
                "path": safe_source_path(record["original_path"], root),
                "fileId": record["source_fileid"], "etag": record["response_etag"],
                "versionId": record["source_version_id"], "preservedRevision": record["revision"],
                "observed": {"sha256": hash_string(record["sha256"]), "size": byte_size(record["size"])},
                "exported": {"sha256": hash_string(record["source_metadata"]["sha256"]),
                             "size": byte_size(record["source_metadata"]["size"])},
                "metadata": {"recoveryEvidence": record, "available": {"upstreamCompleteness": "unknown"}},
                "upstreamCompleteness": "unknown", "knownExportedSlots": ["original"],
            }
            manifest.seed(document, "recovery_revision_needs_owner_review")
    return manifest.summary()


class WebDavSource:
    def __init__(self, http, user, root, rate_bytes=16 * 1024 * 1024, minimum_free=40 * 1024**3):
        self.http = http
        self.prefix = "/remote.php/dav/files/" + quote(user, safe="") + "/"
        self.root = root
        self.rate_bytes = rate_bytes
        self.minimum_free = minimum_free
        if not root or any(p in ("", ".", "..") for p in root.split("/")):
            raise Failure("invalid_source_root")

    def endpoint(self, document):
        if document["revisionKind"] != "current" or document.get("preservedRevision"):
            raise Failure("historical_resolution_unavailable")
        return self.prefix + quote(safe_source_path(document["path"], self.root), safe="/")

    def check(self, document):
        if document["observed"] != document["exported"]:
            raise Failure("source_revision_diverged")
        path = self.endpoint(document)
        etag = document.get("etag")
        if not isinstance(etag, str) or not etag.startswith('"') or not etag.endswith('"'):
            raise Failure("strong_source_etag_required")
        body = b'<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><d:getetag/><d:getcontentlength/><d:resourcetype/><oc:fileid/></d:prop></d:propfind>'
        with self.http.stream("PROPFIND", path, body, {"Depth": "0", "Content-Type": "application/xml"}) as response:
            if response.status != 207:
                raise Failure("invalid_webdav_status")
            raw = response.read(65537)
        if len(raw) > 65536 or b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
            raise Failure("invalid_webdav_document")
        try:
            tree = ET.fromstring(raw)
            entries = tree.findall("{DAV:}response")
            if len(entries) != 1:
                raise Failure("invalid_webdav_response")
            entry = entries[0]
            if unquote(urlsplit(entry.findtext("{DAV:}href", "")).path) != unquote(path):
                raise Failure("webdav_identity_mismatch")
            props = {}
            for propstat in entry.findall("{DAV:}propstat"):
                if " 200 " in propstat.findtext("{DAV:}status", ""):
                    prop = propstat.find("{DAV:}prop")
                    if prop is not None:
                        props.update({v.tag: v.text for v in prop})
                        if prop.find(".//{DAV:}collection") is not None:
                            raise Failure("source_is_directory")
            if (props.get("{DAV:}getetag") != etag
                    or props.get("{http://owncloud.org/ns}fileid") != str(document["fileId"])
                    or int(props.get("{DAV:}getcontentlength", "-1")) != document["observed"]["size"]):
                raise Failure("source_changed")
        except (ET.ParseError, ValueError):
            raise Failure("invalid_webdav_document") from None

    def stage(self, manifest, item, max_bytes):
        document = item["document"]
        size = document["observed"]["size"]
        if size > max_bytes:
            raise Failure("unsupported_source_size")
        self.check(document)
        stage_root = private_dir(manifest.root / "staging")
        relative = item["key"] + ".original"
        final = inside(stage_root, relative)
        expected_hash = document["observed"]["sha256"]
        if final.exists():
            check_file(final, expected_hash, size)
        else:
            if shutil.disk_usage(stage_root).free < self.minimum_free + size:
                raise Failure("staging_disk_reserve", retryable=True)
            partial = inside(stage_root, relative + ".part")
            sha = hashlib.sha256()
            counted = 0
            fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as output:
                with self.http.stream("GET", self.endpoint(document), headers={"If-Match": document["etag"]}) as response:
                    if response.status != 200 or response.getheader("ETag") != document["etag"]:
                        raise Failure("source_changed")
                    for part in chunks(response, size, self.rate_bytes):
                        output.write(part)
                        sha.update(part)
                        counted += len(part)
                output.flush()
                os.fsync(output.fileno())
            if counted != size:
                raise Failure("source_truncated", retryable=True)
            if sha.hexdigest() != expected_hash:
                raise Failure("source_bytes_mismatch")
            partial.replace(final)
            sync_directory(stage_root)
            check_file(final, expected_hash, size)
        with final.open("rb") as source:
            mime = sniff(source.read(4096))
        metadata = canonical(document)
        atomic_write(stage_root / (item["key"] + ".metadata.json"), metadata)
        manifest.update(item["key"], stage="staging/" + relative, mime=mime, phase="staged", error=None)
        return final, metadata, mime
