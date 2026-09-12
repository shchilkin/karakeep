import hashlib
import json
import os
import re
from pathlib import Path


class Failure(Exception):
    """A public reason code, never a URL, token, path, or provider response."""

    def __init__(self, code, *, retryable=False):
        self.code = code
        self.retryable = retryable
        super().__init__(code)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def opaque(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", value):
        raise Failure("invalid_target_identifier")
    return value


def hash_string(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise Failure("invalid_digest")
    return value


def byte_size(value):
    if type(value) is not int or value < 1:
        raise Failure("invalid_size")
    return value


def private_dir(path):
    path = Path(path)
    if path.is_symlink():
        raise Failure("symlink_state_directory")
    path.mkdir(parents=True, mode=0o700, exist_ok=True)
    if path.stat().st_mode & 0o077:
        raise Failure("state_directory_not_private")
    return path.resolve()


def inside(root, relative):
    root = Path(root).resolve()
    candidate = root / relative
    if candidate.is_symlink():
        raise Failure("symlink_file")
    result = candidate.resolve()
    if not result.is_relative_to(root) or result == root:
        raise Failure("path_outside_root")
    return result


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write(path, data):
    path = Path(path)
    temporary = path.with_name(path.name + ".part")
    if path.is_symlink() or temporary.is_symlink():
        raise Failure("symlink_file")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    temporary.replace(path)
    sync_directory(path.parent)


def file_hash(path, max_bytes=None):
    sha = hashlib.sha256()
    size = 0
    with Path(path).open("rb") as source:
        while chunk := source.read(1024 * 1024):
            size += len(chunk)
            if max_bytes is not None and size > max_bytes:
                raise Failure("file_exceeds_expected_size")
            sha.update(chunk)
    return sha.hexdigest(), size


def check_file(path, sha256, size):
    if file_hash(path, size) != (sha256, size):
        raise Failure("stored_bytes_mismatch")


def read_json(path, limit=4 * 1024 * 1024):
    path = Path(path)
    if path.stat().st_size > limit:
        raise Failure("json_size_limit")
    try:
        return json.loads(path.read_bytes())
    except (ValueError, UnicodeError):
        raise Failure("invalid_json") from None


def sniff(head):
    # Only byte signatures; extension and remote MIME are never authoritative.
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(b"%PDF-"):
        return "application/pdf"
    if head.startswith(b"8BPS"):
        return "image/vnd.adobe.photoshop"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand == b"qt  ":
            return "video/quicktime"
        if brand in (b"M4V ", b"M4VH", b"M4VP"):
            return "video/x-m4v"
        if brand in (b"isom", b"iso2", b"mp41", b"mp42", b"avc1", b"MSNV"):
            return "video/mp4"
        return "application/octet-stream"
    if head.startswith(b"\x1aE\xdf\xa3") and b"webm" in head[:4096]:
        return "video/webm"
    return "application/octet-stream"
