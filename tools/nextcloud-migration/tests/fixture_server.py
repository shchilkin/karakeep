"""Synthetic HTTP contract fixture, never a production API implementation."""
import base64
import copy
import hashlib
import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, unquote
from xml.sax.saxutils import escape

from migration_client.core import canonical, digest, sniff
from migration_client.target import BASE, CONTRACT

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6MIcAAAAASUVORK5CYII=")


class Fixture:
    def __init__(self):
        self.files = {}
        self.operations = {}
        self.keys = {}
        self.calls = []
        self.existing = {"untouched": {"title": "Owner title", "note": "Owner note", "assets": ["old-asset"]}}
        self.existing_before = copy.deepcopy(self.existing)
        self.drop_once = None
        self.corrupt_original = False
        self.corrupt_metadata = False
        self.corrupt_mapping = False
        self.source_truncate_once = False
        self.materialize = True
        self.content_matches = []
        self.fence = 1
        self.recipe_error = None
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def send(self, value, status=200, headers=None):
                body = canonical(value) if isinstance(value, (dict, list)) else value
                if fixture.drop_once == (self.command, self.path):
                    fixture.drop_once = None
                    self.close_connection = True
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                self.send_response(status)
                for key, val in (headers or {}).items():
                    self.send_header(key, val)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                self.handle_request()

            def do_POST(self):
                self.handle_request()

            def do_PUT(self):
                self.handle_request()

            def do_PROPFIND(self):
                self.handle_request()

            def handle_request(self):
                fixture.calls.append((self.command, self.path, self.headers.get("Idempotency-Key")))
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                path = self.path
                if path in fixture.files:
                    file = fixture.files[path]
                    if self.command == "PROPFIND":
                        xml = ('<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:response>'
                               '<d:href>' + escape(path) + '</d:href><d:propstat><d:prop>'
                               '<d:getetag>' + escape(file["etag"]) + '</d:getetag>'
                               '<oc:fileid>' + file["fileId"] + '</oc:fileid><d:getcontentlength>'
                               + str(len(file["bytes"])) + '</d:getcontentlength><d:resourcetype/>'
                               '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>'
                               '</d:response></d:multistatus>').encode()
                        return self.send(xml, 207)
                    if self.headers.get("If-Match") != file["etag"]:
                        return self.send({}, 412)
                    if fixture.source_truncate_once:
                        fixture.source_truncate_once = False
                        self.send_response(200)
                        self.send_header("ETag", file["etag"])
                        self.send_header("Content-Length", str(len(file["bytes"])))
                        self.end_headers()
                        self.wfile.write(file["bytes"][:7])
                        self.wfile.flush()
                        self.close_connection = True
                        return
                    return self.send(file["bytes"], headers={"ETag": file["etag"]})
                if path == BASE + "/capabilities":
                    return self.send({"contractVersion": CONTRACT, "storageMode": "copy", "physicalReuse": False,
                                      "persistentDeferred": True, "materialize": fixture.materialize,
                                      "maxAttachments": 1, "maxFileBytes": 52428800, "maxMetadataBytes": 4194304,
                                      "supportedMimeTypes": ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"],
                                      "historicalResolution": False, "stagePermits": False})
                if path in (BASE + "/lookup", BASE + "/reservations"):
                    payload = json.loads(raw)
                    source_key = digest(payload["source"])
                    found = next((op for op in fixture.operations.values() if op["sourceKey"] == source_key), None)
                    if path.endswith("/lookup"):
                        return self.send({"sourceMatch": "same_revision" if found else "new_source",
                                          "operationId": found["operationId"] if found else None,
                                          "contentMatches": fixture.content_matches, "physicalReuse": False})
                    key = self.headers.get("Idempotency-Key")
                    if key in fixture.keys and fixture.keys[key] != digest(payload):
                        return self.send({}, 409)
                    fixture.keys[key] = digest(payload)
                    if found:
                        if found["payloadDigest"] != digest(payload):
                            return self.send({}, 409)
                        found["fencingToken"] = fixture.fence
                        return self.send(fixture.status(found))
                    opid = "operation-" + str(len(fixture.operations) + 1)
                    op = {"operationId": opid, "sourceKey": source_key, "payload": payload,
                          "payloadDigest": digest(payload), "state": "reserved", "fencingToken": fixture.fence,
                          "metadata": None, "original": None, "receipt": None}
                    fixture.operations[opid] = op
                    return self.send(fixture.status(op))
                if path.startswith(BASE + "/reservations/"):
                    rest = path[len(BASE + "/reservations/"):].split("/")
                    op = fixture.operations.get(rest[0])
                    if not op:
                        return self.send({}, 404)
                    suffix = "/".join(rest[1:])
                    if self.command == "GET" and not suffix:
                        return self.send(fixture.status(op))
                    if self.command == "GET" and suffix == "metadata":
                        value = op["metadata"] or b""
                        return self.send(value[:-1] + b"X" if fixture.corrupt_metadata else value)
                    if self.command == "PUT":
                        if self.headers.get("X-Import-Fence") != str(op["fencingToken"]):
                            return self.send({}, 409)
                        which = "metadata" if suffix == "metadata" else "original"
                        expected = op["payload"]["metadata"] if which == "metadata" else op["payload"]["attachments"][0]["observed"]
                        if (hashlib.sha256(raw).hexdigest(), len(raw)) != (expected["sha256"], expected["size"]):
                            return self.send({}, 409)
                        op[which] = raw
                        return self.send(fixture.status(op))
                    if suffix in ("verify", "commit"):
                        if json.loads(raw)["fencingToken"] != op["fencingToken"]:
                            return self.send({}, 409)
                        if op["metadata"] is None or op["original"] is None:
                            return self.send({}, 409)
                        if suffix == "verify":
                            op["state"] = "verified"
                            return self.send(fixture.status(op))
                        op["state"] = "committed"
                        if not op["receipt"]:
                            num = rest[0].split("-")[-1]
                            expected = op["payload"]["attachments"][0]["observed"]
                            op["receipt"] = {"operationId": rest[0], "sourceRevisionId": rest[0],
                                             "bookmarkId": "bookmark-" + num,
                                             "assets": [{"slot": "original", "assetId": "asset-" + num,
                                                         "storedSha256": expected["sha256"], "storedSize": expected["size"],
                                                         "storageGeneration": "generation-" + num}],
                                             "metadataSha256": op["payload"]["metadata"]["sha256"],
                                             "metadataSize": op["payload"]["metadata"]["size"],
                                             "metadataUrl": BASE + "/reservations/" + rest[0] + "/metadata",
                                             "processingPolicy": "deferred", "policyRevision": 1,
                                             "contentRevision": 1, "physicalReuse": False}
                        return self.send(op["receipt"])
                for op in fixture.operations.values():
                    receipt = op["receipt"]
                    if not receipt:
                        continue
                    if path == "/api/v1/assets/" + receipt["assets"][0]["assetId"]:
                        value = op["original"]
                        return self.send(value[:-1] + b"X" if fixture.corrupt_original else value)
                    if path == "/api/v1/bookmarks/" + receipt["bookmarkId"]:
                        mapping = op["payload"]["mapping"]
                        return self.send({"id": receipt["bookmarkId"],
                                          "title": "Wrong mapping" if fixture.corrupt_mapping else mapping["title"],
                                          "note": mapping["note"], "createdAt": mapping["savedAt"],
                                          "tags": [{"name": tag.strip().lstrip("#").strip()} for tag in mapping["tags"]],
                                          "content": {"type": "asset", "assetId": receipt["assets"][0]["assetId"],
                                                      "sourceUrl": mapping["sourceUrl"]}})
                return self.send({}, 404)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.origin = "http://127.0.0.1:" + str(self.server.server_port)

    def status(self, op):
        expected = op["payload"]["attachments"][0]["observed"]
        return {"operationId": op["operationId"], "sourceRevisionId": op["operationId"],
                "state": op["state"], "payloadDigest": op["payloadDigest"],
                "fencingToken": op["fencingToken"], "leaseUntil": 2000000000000,
                "metadataVerified": op["metadata"] is not None,
                "files": [{"slot": "original", "state": "verified" if op["original"] else "pending",
                           "detectedMime": sniff(op["original"] or b""),
                           "storedSha256": expected["sha256"] if op["original"] else None,
                           "storedSize": expected["size"] if op["original"] else None}],
                "receipt": op["receipt"]}

    def document(self, object_id="synthetic-one", body=PNG, filename="misleading.json"):
        path = "MyMind/Files/" + object_id + "/" + filename
        endpoint = "/remote.php/dav/files/fixture/" + quote(path, safe="/")
        self.files[endpoint] = {"bytes": body, "etag": '"fixture-etag"', "fileId": "100"}
        expected = {"sha256": hashlib.sha256(body).hexdigest(), "size": len(body)}
        return {"provider": "mymind", "transportProvider": "nextcloud-webdav", "accountScope": "synthetic-account",
                "sourceObjectId": object_id, "revisionKind": "current", "path": path,
                "fileId": "100", "etag": '"fixture-etag"', "observed": expected.copy(), "exported": expected.copy(),
                "metadata": {"originalRecord": {"object_id": object_id, "title": "Synthetic image",
                                                "created": "2021-03-30T10:13:53.743900Z", "modified": "2026-01-01T00:00:00Z",
                                                "tags": '["#reference", "untouched original tag"]'},
                             "available": {"sourceUrl": "not_exported", "collections": "not_exported", "carousel": "unknown"}},
                "upstreamCompleteness": "unknown", "knownExportedSlots": ["original"]}

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
