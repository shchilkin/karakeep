import time

from .core import Failure, canonical, check_file, inside
from .target import reservation_payload


def run_pilot(manifest, source, target, limit=1, max_bytes=256 * 1024 * 1024, fault=None, item_keys=None):
    """Bounded client. Caller must establish operator/backup approval first."""
    if type(max_bytes) is not int or not 1 <= max_bytes <= 256 * 1024 * 1024:
        raise Failure("pilot_byte_limit")
    caps = target.capabilities()  # Before PROPFIND/GET/staging or any target mutation.
    if item_keys is None:
        selected = manifest.items(limit)
    else:
        if (type(limit) is not int or not 1 <= limit <= 12
                or not isinstance(item_keys, list) or not 1 <= len(item_keys) <= 12
                or any(not isinstance(key, str) for key in item_keys)
                or len(set(item_keys)) != len(item_keys)):
            raise Failure("exact_pilot_selection_required")
        approved = [manifest.get(key) for key in item_keys]
        if any(item["hold"] for item in approved):
            raise Failure("approved_item_held")
        selected = [item for item in approved if item["phase"] != "verified"][:limit]
    total = sum(item["document"]["observed"]["size"] for item in selected)
    if total > max_bytes:
        raise Failure("pilot_byte_limit")
    for selected_item in selected:
        key = selected_item["key"]
        try:
            item = manifest.get(key)
            if item["hold"]:
                continue
            original, metadata, mime = source.stage(manifest, item, caps["maxFileBytes"])
            item = manifest.get(key)
            if fault:
                fault("after_stage")
            if mime not in caps["supportedMimeTypes"]:
                raise Failure("unsupported_source_format")
            if len(metadata) > caps["maxMetadataBytes"]:
                raise Failure("unsupported_metadata_size")
            payload = reservation_payload(item, metadata)
            status = target.reserve(manifest, item, payload)
            if fault:
                fault("after_reserve")
            if status["state"] == "committed":
                receipt = status.get("receipt")
                target.check_receipt(receipt, payload, status["operationId"])
                manifest.update(key, phase="committed", receipt=receipt)
            else:
                status = target.upload(manifest, item, payload, status, original, metadata)
                if fault:
                    fault("after_upload")
                # Detect source edits during staging/upload before materialization.
                source.check(item["document"])
                check_file(original, item["document"]["observed"]["sha256"], item["document"]["observed"]["size"])
                receipt = target.commit(manifest, item, payload, status)
            if fault:
                fault("after_commit")
            target.readback(manifest, item, payload, receipt)
            if fault:
                fault("after_readback")
        except Failure as error:
            manifest.update(key, error=error.code, **({} if error.retryable else {"hold": error.code}))
            manifest.event(key, error.code)
            # Stop this chunk. There is no implicit retry, skip-as-success or cleanup.
            raise
    return manifest.summary()


def dry_run(manifest, source, target, limit=1):
    caps = target.capabilities()
    report = {"checked": 0, "wouldStage": 0, "holds": {}, "targetMutations": 0, "sourceBytesRead": 0}
    for item in manifest.items(limit):
        try:
            if item["document"]["observed"]["size"] > caps["maxFileBytes"]:
                raise Failure("unsupported_source_size")
            source.check(item["document"])
            # MIME is deliberately unknown until actual staged bytes are sniffed.
            report["wouldStage"] += 1
        except Failure as error:
            report["holds"][error.code] = report["holds"].get(error.code, 0) + 1
        report["checked"] += 1
    return report


def reconcile(manifest, source, target, limit=12):
    """Only source PROPFIND and target GET; never reserve, upload, commit or retry."""
    target.capabilities()
    report = {"checked": 0, "verified": 0, "needsAttention": {}, "targetMutations": 0}
    # Include verified/held records: reconciliation must detect later loss too.
    for item in manifest.reconciliation_items(limit):
        key = item["key"]
        try:
            source.check(item["document"])
            if not item["stage"]:
                raise Failure("stage_missing")
            original = inside(manifest.root, item["stage"])
            check_file(original, item["document"]["observed"]["sha256"], item["document"]["observed"]["size"])
            metadata = canonical(item["document"])
            payload = reservation_payload(item, metadata)
            status = target.status(item["receipt"]["operationId"], payload)
            if status["state"] != "committed" or status.get("receipt") != item["receipt"]:
                raise Failure("target_receipt_changed")
            target.readback(manifest, item, payload, item["receipt"])
            report["verified"] += 1
        except Failure as error:
            manifest.update(key, error=error.code, hold=error.code)
            manifest.event(key, error.code)
            report["needsAttention"][error.code] = report["needsAttention"].get(error.code, 0) + 1
        report["checked"] += 1
        manifest.update(key, last_checked=time.time())
    return report
