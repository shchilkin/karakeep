import contextlib
import http.client
import json
import socket
import ssl
import time
from urllib.parse import urlsplit

from .core import Failure, canonical


class Http:
    """Fixed origin, no redirects/proxy env, bounded responses, redacted errors."""

    def __init__(self, origin, authorization, timeout=60, max_json=4 * 1024 * 1024):
        parts = urlsplit(origin)
        if (parts.scheme not in ("http", "https") or not parts.hostname or parts.username
                or parts.password or parts.query or parts.fragment or parts.path not in ("", "/")):
            raise Failure("invalid_origin")
        if not 1 <= timeout <= 120:
            raise Failure("invalid_timeout")
        self.origin = origin.rstrip("/")
        self.parts = parts
        self.authorization = authorization
        self.timeout = timeout
        self.max_json = max_json

    @contextlib.contextmanager
    def stream(self, method, path, body=None, headers=None):
        if (not path.startswith("/") or path.startswith("//") or "\r" in path or "\n" in path
                or "#" in path or "?" in path):
            raise Failure("invalid_request_path")
        connection_type = http.client.HTTPSConnection if self.parts.scheme == "https" else http.client.HTTPConnection
        connection = connection_type(self.parts.hostname, self.parts.port, timeout=self.timeout)
        response = None
        request_headers = {"Authorization": self.authorization, "Accept-Encoding": "identity",
                           "User-Agent": "KarakeepMigration/0.1"}
        request_headers.update(headers or {})
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            if not 200 <= response.status < 300:
                status = response.status
                # Do not read/log an error body: it can contain private media/paths.
                if status in (401, 403):
                    raise Failure("authentication_or_scope")
                if status == 404:
                    raise Failure("resource_unavailable")
                if status == 412:
                    raise Failure("source_changed")
                if status == 409:
                    raise Failure("target_conflict")
                if status == 413:
                    raise Failure("target_size_limit")
                if status == 429:
                    raise Failure("target_backpressure", retryable=True)
                if 300 <= status < 400:
                    raise Failure("redirect_rejected")
                raise Failure("remote_unavailable", retryable=status >= 500)
            if response.getheader("Content-Encoding", "identity").lower() != "identity":
                raise Failure("unexpected_content_encoding")
            yield response
        except (OSError, socket.timeout, http.client.HTTPException, ssl.SSLError):
            raise Failure("transport_uncertain", retryable=True) from None
        finally:
            if response:
                response.close()
            connection.close()

    def json(self, method, path, payload=None, headers=None):
        encoded = canonical(payload) if payload is not None else None
        request_headers = {"Content-Type": "application/json"}
        request_headers.update(headers or {})
        with self.stream(method, path, encoded, request_headers) as response:
            data = response.read(self.max_json + 1)
            if len(data) > self.max_json:
                raise Failure("target_response_size_limit")
            try:
                value = json.loads(data)
            except (ValueError, UnicodeError):
                raise Failure("invalid_target_json") from None
            if not isinstance(value, dict):
                raise Failure("invalid_target_shape")
            return value

    def upload(self, path, source, size, fence, content_type):
        with self.stream("PUT", path, source, {"Content-Length": str(size),
                          "Content-Type": content_type, "X-Import-Fence": str(fence)}) as response:
            data = response.read(self.max_json + 1)
            if len(data) > self.max_json:
                raise Failure("target_response_size_limit")
            try:
                value = json.loads(data)
            except (ValueError, UnicodeError):
                raise Failure("invalid_target_json") from None
            if not isinstance(value, dict):
                raise Failure("invalid_target_shape")
            return value


def chunks(response, maximum, rate_bytes=16 * 1024 * 1024, deadline=120):
    started = time.monotonic()
    size = 0
    while True:
        if time.monotonic() - started > deadline:
            raise Failure("stream_deadline", retryable=True)
        part = response.read(min(1024 * 1024, maximum - size + 1))
        if not part:
            break
        size += len(part)
        if size > maximum:
            raise Failure("stream_size_limit")
        yield part
        if rate_bytes:
            delay = size / rate_bytes - (time.monotonic() - started)
            if delay > 0:
                time.sleep(delay)
