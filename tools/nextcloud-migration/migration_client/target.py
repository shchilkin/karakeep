import hashlib
import json
from datetime import datetime
from pathlib import PurePosixPath

from .core import Failure, canonical, digest, opaque
from .http import chunks

CONTRACT = "deferred-copy-v1"
BASE = "/api/v1/import"
MAX_FILE = 50 * 1024 * 1024
MAX_METADATA = 4 * 1024 * 1024
MIMES = {"image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf", "video/mp4", "video/webm", "video/quicktime", "video/x-m4v", "video/x-matroska"}


def reservation_payload(item, metadata):
    doc = item["document"]
    raw = doc["metadata"].get("originalRecord", {})
    try:
        tags = json.loads(raw.get("tags") or "[]")
    except (ValueError, TypeError):
        raise Failure("source_metadata_tags_invalid") from None
    title = raw.get("title") or None
    if (not isinstance(tags, list) or len(tags) > 100
            or any(not isinstance(tag, str) or not tag or len(tag) > 200 for tag in tags)
            or title is not None and (not isinstance(title, str) or len(title) > 1000)):
        raise Failure("unsupported_metadata_mapping")
    for field in (doc["provider"], doc["accountScope"], doc["sourceObjectId"], item["revision"]):
        if not isinstance(field, str) or not 1 <= len(field) <= 512:
            raise Failure("source_identity_limit")
    filename = PurePosixPath(doc["path"]).name
    if not 1 <= len(filename) <= 1024:
        raise Failure("source_name_limit")
    return {
        "contractVersion": CONTRACT,
        "source": {"provider": doc["provider"], "accountScope": doc["accountScope"],
                   "objectId": doc["sourceObjectId"], "revision": item["revision"],
                   "revisionKind": doc["revisionKind"]},
        "metadata": {"sha256": hashlib.sha256(metadata).hexdigest(), "size": len(metadata)},
        "mapping": {"title": title, "note": None, "sourceUrl": None,
                    "savedAt": raw.get("created") or None, "tags": tags},
        "completeness": "unknown",
        "attachments": [{"slot": "original", "ordinal": 0, "role": "original",
                         "originalName": filename, "observed": doc["observed"],
                         "exported": doc["exported"],
                         "transport": {"provider": "nextcloud-webdav", "path": doc["path"],
                                       "fileId": doc["fileId"], "etag": doc["etag"]}}],
        "processingPolicy": "deferred", "storageMode": "copy",
    }


class Target:
    def __init__(self, http, minimum_write_gap=3, max_file_bytes=MAX_FILE):
        if type(max_file_bytes) is not int or not 1 <= max_file_bytes <= 4096 * 1024**2:
            raise Failure("invalid_client_file_limit")
        self.http = http
        self.minimum_write_gap = minimum_write_gap
        self.max_file_bytes = max_file_bytes

    def capabilities(self):
        try:
            caps = self.http.json("GET", BASE + "/capabilities")
        except Failure as error:
            if error.code == "remote_precondition_failed":
                raise Failure("foundation_capabilities_unavailable") from None
            raise
        if (caps.get("contractVersion") != CONTRACT or caps.get("storageMode") != "copy"
                or caps.get("physicalReuse") is not False or caps.get("persistentDeferred") is not True
                or caps.get("materialize") is not True or caps.get("maxAttachments") != 1
                or not isinstance(caps.get("supportedMimeTypes"), list)
                or any(not isinstance(mime, str) for mime in caps["supportedMimeTypes"])
                or type(caps.get("maxFileBytes")) is not int or caps["maxFileBytes"] < 1
                or type(caps.get("maxMetadataBytes")) is not int or caps["maxMetadataBytes"] < 1):
            raise Failure("foundation_capabilities_unavailable")
        return {"maxFileBytes": min(caps["maxFileBytes"], self.max_file_bytes),
                "maxMetadataBytes": min(caps["maxMetadataBytes"], MAX_METADATA),
                "supportedMimeTypes": set(caps["supportedMimeTypes"]) & MIMES,
                # Absence means an older, asset-only server, never native support.
                "supportedBookmarkTypes": caps.get("supportedBookmarkTypes", ["asset"])}

    def check_status(self, status, payload, operation_id=None):
        operation_id = opaque(operation_id or status.get("operationId"))
        if (status.get("operationId") != operation_id or status.get("sourceRevisionId") != operation_id
                or status.get("payloadDigest") != digest(payload)):
            raise Failure("target_operation_mismatch")
        state = status.get("state")
        if state == "hold":
            raise Failure("target_held")
        if state not in ("reserved", "verified", "committed"):
            raise Failure("invalid_target_state")
        if type(status.get("fencingToken")) is not int or status["fencingToken"] < 1:
            raise Failure("invalid_target_fence")
        if type(status.get("leaseUntil")) not in (int, float):
            raise Failure("invalid_target_lease")
        return status

    def status(self, operation_id, payload):
        status = self.http.json("GET", BASE + "/reservations/" + opaque(operation_id))
        return self.check_status(status, payload, operation_id)

    def recover_reservation(self, manifest, item, payload):
        """Read-only recovery of a journaled intent; never admits a new file."""
        operation = manifest.find_operation(item["key"], "reserve")
        if not operation:
            return None
        if operation["payload_digest"] != digest(payload):
            raise Failure("operation_payload_changed")
        previous = json.loads(operation["response"]) if operation["response"] else None
        if previous:
            return self.status(previous["operationId"], payload)
        lookup = self.http.json("POST", BASE + "/lookup", payload)
        if lookup.get("physicalReuse") is not False:
            raise Failure("copy_mode_required")
        match = lookup.get("sourceMatch")
        if match == "source_conflict":
            raise Failure("target_source_conflict")
        if match not in ("new_source", "same_revision"):
            raise Failure("invalid_lookup_shape")
        if match == "same_revision":
            return self.status(opaque(lookup.get("operationId")), payload)
        return None

    def reserve(self, manifest, item, payload):
        key = item["key"]
        operation = manifest.operation(key, "reserve", payload)
        status = self.recover_reservation(manifest, item, payload)
        if status and status["state"] == "committed":
            manifest.record_response(key, "reserve", status)
            return status
        # Re-reserve with the original body/key renews an expired lease/fence.
        # No new source revision, transport key, or metadata is invented.
        manifest.pace_write(self.minimum_write_gap)
        status = self.http.json("POST", BASE + "/reservations", payload,
                                {"Idempotency-Key": operation["idempotency_key"]})
        self.check_status(status, payload)
        manifest.record_response(key, "reserve", status)
        manifest.update(key, phase="reserved")
        return status

    def upload(self, manifest, item, payload, status, original, metadata):
        import io
        operation_id = opaque(status["operationId"])
        path = BASE + "/reservations/" + operation_id
        fence = status["fencingToken"]
        # These PUTs are idempotent by operation/slot/expected bytes and renewed fence.
        # The backend rechecks original and metadata bytes; client flags confer no authority.
        manifest.pace_write(self.minimum_write_gap)
        result = self.http.upload(path + "/metadata", io.BytesIO(metadata), len(metadata), fence, "application/json")
        self.check_status(result, payload, operation_id)
        if "content" not in payload:
            manifest.pace_write(self.minimum_write_gap)
            with original.open("rb") as source:
                result = self.http.upload(path + "/files/original", source, original.stat().st_size, fence,
                                          "application/octet-stream")
            self.check_status(result, payload, operation_id)
        manifest.pace_write(self.minimum_write_gap)
        result = self.http.json("POST", path + "/verify", {"fencingToken": fence})
        self.check_status(result, payload, operation_id)
        files = result.get("files")
        if "content" in payload:
            if result["state"] != "verified" or result.get("metadataVerified") is not True or files != []:
                raise Failure("target_stage_not_verified")
            manifest.update(item["key"], phase="uploaded")
            return result
        observed = payload["attachments"][0]["observed"]
        if (result["state"] != "verified" or result.get("metadataVerified") is not True
                or not isinstance(files, list) or len(files) != 1 or files[0].get("slot") != "original"
                or files[0].get("state") != "verified"
                or files[0].get("storedSha256") != observed["sha256"]
                or files[0].get("storedSize") != observed["size"]
                or files[0].get("detectedMime") != item["mime"]):
            raise Failure("target_stage_not_verified")
        manifest.update(item["key"], phase="uploaded")
        return result

    def commit(self, manifest, item, payload, status):
        operation_id = opaque(status["operationId"])
        # Persist intent before network. Fence may change after restart; semantic
        # commit identity is the operation, not a disposable lease generation.
        manifest.operation(item["key"], "commit", {"operationId": operation_id, "payloadDigest": digest(payload)})
        current = self.status(operation_id, payload)
        if current["state"] == "committed":
            receipt = current.get("receipt")
        else:
            manifest.pace_write(self.minimum_write_gap)
            receipt = self.http.json("POST", BASE + "/reservations/" + operation_id + "/commit",
                                     {"fencingToken": status["fencingToken"]})
        self.check_receipt(receipt, payload, operation_id)
        manifest.record_response(item["key"], "commit", receipt)
        manifest.update(item["key"], receipt=receipt, phase="committed")
        return receipt

    def check_receipt(self, receipt, payload, operation_id):
        if not isinstance(receipt, dict):
            raise Failure("invalid_target_receipt")
        assets = receipt.get("assets")
        if (receipt.get("operationId") != operation_id or receipt.get("sourceRevisionId") != operation_id
                or receipt.get("processingPolicy") != "deferred" or receipt.get("physicalReuse") is not False
                or receipt.get("policyRevision") != 1 or receipt.get("contentRevision") != 1
                or receipt.get("metadataSha256") != payload["metadata"]["sha256"]
                or receipt.get("metadataSize") != payload["metadata"]["size"]):
            raise Failure("target_receipt_mismatch")
        opaque(receipt.get("bookmarkId"))
        if "content" in payload:
            if assets != []:
                raise Failure("target_receipt_mismatch")
        else:
            expected = payload["attachments"][0]["observed"]
            if (not isinstance(assets, list) or len(assets) != 1 or not isinstance(assets[0], dict)
                    or assets[0].get("slot") != "original"
                    or assets[0].get("storedSha256") != expected["sha256"]
                    or assets[0].get("storedSize") != expected["size"]
                    or not isinstance(assets[0].get("storageGeneration"), str) or not assets[0]["storageGeneration"]):
                raise Failure("target_receipt_mismatch")
            opaque(assets[0].get("assetId"))
        expected_path = BASE + "/reservations/" + opaque(operation_id) + "/metadata"
        locator = receipt.get("metadataUrl")
        if locator != expected_path:
            raise Failure("metadata_locator_mismatch")

    def verify_download(self, path, expected):
        sha, size = hashlib.sha256(), 0
        with self.http.stream("GET", path) as response:
            if response.status != 200:
                raise Failure("target_original_partial_response")
            for chunk in chunks(response, expected["size"], rate_bytes=0):
                size += len(chunk)
                sha.update(chunk)
        if (sha.hexdigest(), size) != (expected["sha256"], expected["size"]):
            raise Failure("target_readback_mismatch")

    def verify_mapping(self, receipt, payload):
        bookmark = self.http.json("GET", "/api/v1/bookmarks/" + opaque(receipt["bookmarkId"]))
        mapping = payload["mapping"]
        normalized_tags = {tag.strip().lstrip("#").strip() for tag in mapping["tags"]}
        got_tags = bookmark.get("tags")
        if not isinstance(got_tags, list) or any(not isinstance(tag, dict) for tag in got_tags):
            raise Failure("target_mapping_mismatch")
        # Released imports may have additive AI tags. Source associations remain human
        # and must still match exactly; raw source metadata is independently hashed.
        processing = bookmark.get("importProcessing")
        mapped_tags = got_tags
        if isinstance(processing, dict) and processing.get("generation", 0) > 0:
            if any(tag.get("attachedBy") not in ("human", "ai") for tag in got_tags):
                raise Failure("target_mapping_mismatch")
            mapped_tags = [tag for tag in got_tags if tag.get("attachedBy") == "human"]
        content = bookmark.get("content", {})
        if (bookmark.get("id") != receipt["bookmarkId"] or bookmark.get("title") != mapping["title"]
                or bookmark.get("note") != mapping["note"]
                or {tag.get("name") for tag in mapped_tags} != normalized_tags
                or not isinstance(content, dict)):
            raise Failure("target_mapping_mismatch")
        if "content" in payload:
            if (any(content.get(field) != value for field, value in payload["content"].items())
                    or bookmark.get("processingPolicy") != "deferred"
                    or not isinstance(processing, dict) or processing.get("state") != "held"
                    or processing.get("generation") != 0
                    or content.get("type") == "text" and content.get("sourceUrl") != mapping["sourceUrl"]):
                raise Failure("target_mapping_mismatch")
        elif (content.get("type") != "asset"
                or content.get("assetId") != receipt["assets"][0]["assetId"]
                or content.get("sourceUrl") != mapping["sourceUrl"]):
            raise Failure("target_mapping_mismatch")
        if mapping["savedAt"]:
            try:
                expected = datetime.fromisoformat(mapping["savedAt"].replace("Z", "+00:00"))
                actual = datetime.fromisoformat(bookmark["createdAt"].replace("Z", "+00:00"))
                if expected.tzinfo is None or actual.tzinfo is None:
                    raise ValueError()
                # Existing Karakeep SQLite timestamp columns project whole seconds.
                # Raw metadata and the immutable payload retain the exact source value.
                if expected.replace(microsecond=0) != actual:
                    raise ValueError()
            except (ValueError, TypeError, KeyError):
                raise Failure("target_date_mapping_mismatch") from None

    def readback(self, manifest, item, payload, receipt):
        self.check_receipt(receipt, payload, receipt["operationId"])
        if "content" not in payload:
            self.verify_download("/api/v1/assets/" + opaque(receipt["assets"][0]["assetId"]),
                                 payload["attachments"][0]["observed"])
        self.verify_download(BASE + "/reservations/" + opaque(receipt["operationId"]) + "/metadata",
                             payload["metadata"])
        self.verify_mapping(receipt, payload)
        manifest.event(item["key"], "native_metadata_and_mapping_readback_verified" if "content" in payload
                       else "original_metadata_and_mapping_readback_verified")
        manifest.update(item["key"], phase="verified", error=None)
