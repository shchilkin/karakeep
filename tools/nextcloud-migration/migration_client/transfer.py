"""Shared copy transaction; selection, source staging and approval stay with callers."""
from contextlib import contextmanager

from .core import Failure


@contextmanager
def item_attempt(manifest, key):
    """Record failure once and stop the chunk, without retrying or clearing holds."""
    try:
        yield
    except Failure as error:
        manifest.update(key, error=error.code, **({} if error.retryable else {"hold": error.code}))
        manifest.event(key, error.code)
        raise


def finish_import(manifest, target, item, payload, metadata, *, original=None, before_commit=None, fault=None):
    """Recover or commit one prepared copy, then independently verify its readback."""
    status = target.reserve(manifest, item, payload)
    if fault:
        fault("after_reserve")
    if status["state"] == "committed":
        receipt = status.get("receipt")
        target.check_receipt(receipt, payload, status["operationId"])
        manifest.update(item["key"], phase="committed", receipt=receipt)
    else:
        status = target.upload(manifest, item, payload, status, original, metadata)
        if fault:
            fault("after_upload")
        if before_commit:
            before_commit()
        receipt = target.commit(manifest, item, payload, status)
    if fault:
        fault("after_commit")
    target.readback(manifest, item, payload, receipt)
    if fault:
        fault("after_readback")
