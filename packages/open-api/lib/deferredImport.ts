import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  zImportFence,
  zImportReservation,
} from "@karakeep/shared/types/deferredImport";
import { BearerAuth } from "./common";
import { UnauthorizedResponse } from "./errors";
export const registry = new OpenAPIRegistry();
const security = [{ [BearerAuth.name]: [] }];
const tags = ["Deferred imports"];
const json = (schema: z.ZodType) => ({ "application/json": { schema } });
const errors = {
  401: UnauthorizedResponse,
  403: {
    description:
      "Missing imports scope or mutations disabled in read-only mode.",
  },
  404: { description: "Operation is not available to this owner." },
  409: {
    description:
      "Busy, expired fence, conflicting payload, incomplete evidence or held source. Read the operation status before retrying.",
  },
  412: {
    description:
      "Filesystem storage or required database policy barriers are unavailable.",
  },
  413: { description: "Declared or streamed byte limit exceeded." },
  429: { description: "Staging capacity is full." },
};
const id = z.object({ id: z.string() });
registry.registerPath({
  operationId: "getDeferredImportCapabilities",
  method: "get",
  path: "/import/capabilities",
  tags,
  security,
  summary: "Read deferred copy import capabilities",
  description:
    "Requires imports:read. Check contractVersion=deferred-copy-v1 and materialize=true before using the pilot. One original per revision, <=50 MiB, raw JSON metadata <=4 MiB. JPEG/PNG/GIF/WebP/PDF MIME signatures are accepted; no image decode or model is run. Historical resolution and stage permits are unavailable. Supported filesystem and all immutable-policy database barriers are required.",
  responses: {
    200: {
      description:
        "Contract version, materialize/persistentDeferred flags, storageMode=copy, physicalReuse=false, maxAttachments=1, maxFileBytes, maxMetadataBytes, supportedMimeTypes, stagePermits=false, historicalResolution=false.",
    },
    ...errors,
  },
});
registry.registerPath({
  operationId: "lookupDeferredImport",
  method: "post",
  path: "/import/lookup",
  tags,
  security,
  summary: "Look up source identity and exact owner file matches",
  description:
    "Read-only advisory lookup with imports:read. Requires the same body as reservation. Returns sourceMatch (new_source/same_revision/source_conflict), canonical operationId or null, at most 20 owner-only contentMatches, physicalReuse=false. Matching bytes never move an existing asset or overwrite a prior card.",
  request: { body: { required: true, content: json(zImportReservation) } },
  responses: {
    200: { description: "Advisory source and content matches." },
    ...errors,
  },
});
registry.registerPath({
  operationId: "reserveDeferredImport",
  method: "post",
  path: "/import/reservations",
  tags,
  security,
  summary: "Reserve an immutable source revision",
  description:
    "Requires imports:readwrite. Stable Idempotency-Key plus canonical-json-v1 payload identity: recursively sorted object keys, array order retained, UTF-8 JSON without Unicode normalization. The same source revision and payload returns its canonical operation even with another transport key. Conflict never updates the old source. Nonterminal expired leases renew fencingToken. Staging capacity is 16 nonterminal operations per owner and 64 globally; retained staging and metadata count toward quota. Raw reservation JSON is capped at 256 KiB.",
  request: {
    headers: z.object({ "Idempotency-Key": z.string().min(1).max(200) }),
    body: { required: true, content: json(zImportReservation) },
  },
  responses: {
    200: {
      description:
        "Operation status with operationId=sourceRevisionId, state (reserved/verified/hold/committed), payloadDigest, fencingToken, leaseUntil as epoch milliseconds, metadataVerified, files and optional immutable receipt.",
    },
    ...errors,
  },
});
registry.registerPath({
  operationId: "getDeferredImportStatus",
  method: "get",
  path: "/import/reservations/{id}",
  tags,
  security,
  summary: "Recover an operation after a lost response",
  request: { params: id },
  responses: {
    200: {
      description:
        "Owner-only operation status and prior commit receipt. No private storage paths are exposed.",
    },
    ...errors,
  },
});
const binaryBody = {
  required: true,
  content: {
    "application/octet-stream": {
      schema: z.string().openapi({ type: "string", format: "binary" }),
    },
  },
};
const fenceHeaders = z.object({
  "X-Import-Fence": z.string().regex(/^[1-9][0-9]*$/),
});
registry.registerPath({
  operationId: "uploadDeferredImportMetadata",
  method: "put",
  path: "/import/reservations/{id}/metadata",
  tags,
  security,
  summary: "Store the exact raw source metadata envelope",
  description:
    "Requires imports:readwrite. Upload raw UTF-8 JSON bytes matching the reserved SHA-256 and size, up to 4 MiB. Whitespace, field names, unknown fields and byte representation are retained; no lossy mapping replaces the envelope. X-Import-Fence must match the live operation lease.",
  request: { params: id, headers: fenceHeaders, body: binaryBody },
  responses: { 200: { description: "Updated operation status." }, ...errors },
});
registry.registerPath({
  operationId: "readDeferredImportMetadata",
  method: "get",
  path: "/import/reservations/{id}/metadata",
  tags,
  security,
  summary: "Download the exact verified metadata bytes",
  description:
    "Requires imports:read. The receipt's metadataUrl is this relative owner-authenticated route. Download is private/no-store and remains available after commit.",
  request: { params: id },
  responses: {
    200: {
      description:
        "Original envelope bytes as an application/octet-stream attachment.",
    },
    ...errors,
  },
});
registry.registerPath({
  operationId: "uploadDeferredImportFile",
  method: "put",
  path: "/import/reservations/{id}/files/{slot}",
  tags,
  security,
  summary: "Stream one original into private staging",
  description:
    "Requires imports:readwrite. Server computes SHA-256/count, detects MIME signature, fsyncs and rereads the staged bytes. One shared I/O lease, 20-second stream deadlines, <=50 MiB. A declared historical revision, source/export mismatch or unsupported MIME remains held. Never creates a fake image or URL. An incomplete .part is not a verified file; no model, decoder, crawler or source URL fetch occurs.",
  request: {
    params: id.extend({ slot: z.string() }),
    headers: fenceHeaders,
    body: binaryBody,
  },
  responses: {
    200: {
      description:
        "Updated operation status; inspect state and per-file verification before committing.",
    },
    ...errors,
  },
});
registry.registerPath({
  operationId: "verifyDeferredImport",
  method: "post",
  path: "/import/reservations/{id}/verify",
  tags,
  security,
  summary: "Reread staged bytes and metadata",
  request: {
    params: id,
    body: { required: true, content: json(zImportFence) },
  },
  responses: {
    200: {
      description:
        "Verified operation status, or the already committed status.",
    },
    ...errors,
  },
});
registry.registerPath({
  operationId: "commitDeferredImport",
  method: "post",
  path: "/import/reservations/{id}/commit",
  tags,
  security,
  summary: "Atomically publish a deferred copied original",
  description:
    "Requires imports:readwrite. Verifies stage and target bytes, quota and fence, then commits a new asset bookmark, occurrence, source receipt, exact hash index and held internal import.committed outbox event together. A retry returns the same receipt. Separate sources or revisions receive separate cards and asset IDs even when bytes or source URLs match. The snapshot remains deferred and immutable; no release, generated thumbnail, AI, crawl, embeddings, rule or webhook is admitted. Private staged originals remain retained and count toward quota in addition to target copies. Normal legacy import APIs retain their previous semantics.",
  request: {
    params: id,
    body: { required: true, content: json(zImportFence) },
  },
  responses: {
    200: {
      description:
        "ImportReceipt: operationId, sourceRevisionId, bookmarkId, assets[{slot,assetId,storedSha256,storedSize,storageGeneration}], metadataSha256, metadataSize, relative metadataUrl, processingPolicy=deferred, policyRevision=1, contentRevision=1, physicalReuse=false.",
    },
    ...errors,
  },
});
