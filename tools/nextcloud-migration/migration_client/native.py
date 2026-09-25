"""Exact-selection pilot for already-cached native cards; no discovery or source HTTP.

Use a separate manifest/namespace from the WebDAV file pilot. Callers supply an
explicit mapping and retain the full cached record in the document. This does not
interpret rich text, download referenced attachments, or assert completeness.
"""
from urllib.parse import urlsplit

from .core import Failure, canonical, digest
from .target import CONTRACT
from .transfer import finish_import, item_attempt


def native_payload(item, metadata):
    doc = item["document"]
    content, mapping = doc.get("content"), doc.get("mapping")
    if (not isinstance(content, dict) or content.get("type") not in ("link", "text")
            or not isinstance(mapping, dict) or set(mapping) != {"title", "note", "sourceUrl", "savedAt", "tags"}
            or doc.get("revisionKind") != "current"):
        raise Failure("unsupported_native_mapping")
    kind = content["type"]
    field = "url" if kind == "link" else "text"
    value = content.get(field)
    if set(content) != {"type", field} or not isinstance(value, str) or not value.strip():
        raise Failure("unsupported_native_mapping")
    if kind == "link":
        try:
            url = urlsplit(value)
            if url.scheme not in ("http", "https") or not url.netloc or len(value) > 8192:
                raise ValueError()
        except ValueError:
            raise Failure("unsupported_native_mapping") from None
    elif len(value) > 100000:
        raise Failure("unsupported_native_mapping")
    if any(not isinstance(doc.get(field), str) or not 1 <= len(doc[field]) <= 512
           for field in ("provider", "accountScope", "sourceObjectId")):
        raise Failure("source_identity_limit")
    return {"contractVersion": CONTRACT,
            "source": {"provider": doc["provider"], "accountScope": doc["accountScope"],
                       "objectId": doc["sourceObjectId"], "revision": item["revision"], "revisionKind": "current"},
            "metadata": {"sha256": digest(doc), "size": len(metadata)},
            "mapping": mapping, "content": content, "attachments": [], "completeness": "unknown",
            "processingPolicy": "deferred", "storageMode": "copy"}


def run_native_pilot(manifest, target, item_keys, max_bytes=16 * 1024 * 1024, fault=None):
    """Caller must establish owner/backup approval; no implicit batch expansion."""
    if (not isinstance(item_keys, list) or not 1 <= len(item_keys) <= 12
            or any(not isinstance(key, str) for key in item_keys) or len(set(item_keys)) != len(item_keys)):
        raise Failure("exact_pilot_selection_required")
    if type(max_bytes) is not int or not 1 <= max_bytes <= 16 * 1024 * 1024:
        raise Failure("pilot_byte_limit")
    caps = target.capabilities()
    types = caps["supportedBookmarkTypes"]
    if not isinstance(types, list) or any(not isinstance(kind, str) for kind in types):
        raise Failure("native_capabilities_unavailable")
    prepared = []
    for key in item_keys:
        item = manifest.get(key)
        if item["hold"]:
            raise Failure("approved_item_held")
        metadata = canonical(item["document"])
        payload = native_payload(item, metadata)
        if payload["content"]["type"] not in types:
            raise Failure("native_capabilities_unavailable")
        if len(metadata) > caps["maxMetadataBytes"]:
            raise Failure("unsupported_metadata_size")
        if item["phase"] != "verified":
            prepared.append((item, metadata, payload))
    if sum(len(metadata) for _, metadata, _ in prepared) > max_bytes:
        raise Failure("pilot_byte_limit")
    for item, metadata, payload in prepared:
        with item_attempt(manifest, item["key"]):
            finish_import(manifest, target, item, payload, metadata, fault=fault)
    return manifest.summary()
