# E2E fixture only. The upstream release image is no longer publicly pullable.
# Build the SAME release from verified official source, not a third-party mirror.
FROM golang:1.24.2-bookworm@sha256:79390b5e5af9ee6e7b1173ee3eac7fadf6751a545297672916b59bfa0ecf6f71 AS builder
WORKDIR /src
# RELEASE.2025-09-07T16-13-09Z -> 07c3a429bfed433e49018cb0f78a52145d4bedeb
ADD --checksum=sha256:8819e3e7817e46b7b3798f8f200ead208562e571563c2e040352378031abe9f2 https://codeload.github.com/minio/minio/tar.gz/07c3a429bfed433e49018cb0f78a52145d4bedeb /tmp/minio.tar.gz
RUN tar -xzf /tmp/minio.tar.gz --strip-components=1 -C /src \
    && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /minio .

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
COPY --from=builder /minio /usr/local/bin/minio
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /src/LICENSE /usr/share/licenses/minio/LICENSE
RUN mkdir /data && chown 65532:65532 /data
ENV HOME=/tmp
USER 65532:65532
EXPOSE 9000 9001
ENTRYPOINT ["/usr/local/bin/minio"]
