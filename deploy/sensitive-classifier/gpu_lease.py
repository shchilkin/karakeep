"""Cooperative GPU ownership across containers sharing the same bind mount.

The caller MUST unload all model/input tensors before release. Locking just the
forward pass is insufficient: an idle resident model still owns VRAM.
"""
import fcntl
import os
import time


def acquire(path, seconds=10):
    handle = open(path, 'a')
    deadline = time.monotonic() + seconds
    try:
        while True:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return handle
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('gpu_busy') from None
                time.sleep(0.05)
    except BaseException:
        handle.close()
        raise


def configured_lease(required=False):
    path = os.environ.get('GPU_LOCK_FILE')
    if not path and required:
        raise RuntimeError('gpu_lock_required')
    return acquire(path) if path else None
