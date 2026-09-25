import {
  zReleaseImport,
  zImportProcessingView,
} from "@karakeep/shared/types/importProcessing";
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
  400: {
    description: "Invalid input or unsupported processing representation.",
  },
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
    "Requires imports:read. Check contractVersion=deferred-copy-v1 and materialize=true. One original per asset revision, or native link/text content with no attachments when supportedBookmarkTypes advertises it. maxFileBytes and ioTimeoutSeconds reflect configured import limits (defaults 50 MiB and 20 seconds); raw JSON metadata <=4 MiB. JPEG/PNG/GIF/WebP/PDF and MP4/WebM/QuickTime/M4V/Matroska signatures are accepted without decoding or models. Native support requires its additional database guards. Historical resolution remains unavailable. Processing is separate: native cards, PDFs and originals above maxProcessingFileBytes cannot be released.",
  responses: {
    200: {
      description:
        "Contract version, materialize/persistentDeferred flags, supportedBookmarkTypes, storageMode=copy, physicalReuse=false, maxAttachments=1, maxFileBytes, ioTimeoutSeconds, maxMetadataBytes, supportedMimeTypes, maxProcessingFileBytes, processingBookmarkTypes, stagePermits, processingStages, historicalResolution=false.",
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
    "Read-only advisory lookup with imports:read. Requires the same body as reservation. Returns sourceMatch (new_source/same_revision/source_conflict), canonical operationId or null, at most 20 owner-only contentMatches (empty for native content), physicalReuse=false. Matching bytes or native URLs never authorize moving an existing asset or overwriting a prior card.",
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
    "Requires imports:readwrite. Without content, attachments must contain exactly one original (legacy identity unchanged). With content={type:link,url} or {type:text,text}, attachments must be empty and revisionKind current. Link URL must be HTTP(S); text must be nonblank and <=100000 characters. Stable Idempotency-Key plus canonical-json-v1 payload identity: recursively sorted keys, retained array order, UTF-8 JSON without Unicode normalization. Exact source revision/payload retries return the same operation across transport keys; conflicts never overwrite. Expired nonterminal leases renew fencingToken. Capacity is 16 nonterminal operations per owner and 64 globally; retained originals, metadata and native projections count toward quota. Reservation JSON <=256 KiB. The configured file cap applies to new reservations, not recovery of an existing receipt.",
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
    "Requires imports:readwrite. Asset reservations only. Server computes SHA-256/count, detects MIME signature, fsyncs and rereads staged bytes under one shared I/O lease. Configured original I/O deadlines and the reserved declared size are enforced. Historical revisions, source/export mismatches and unsupported MIME remain held. An incomplete .part is not verified. No model, decoder, crawler, source URL fetch or implicit conversion occurs.",
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
  summary: "Atomically publish a deferred source snapshot",
  description:
    "Requires imports:readwrite. Verifies raw metadata, quota and fence, plus staged/target bytes for assets. Atomically commits the native link/text projection or copied asset, source receipt and held import.committed outbox event. Native receipts have assets=[]; file receipts include the exact hash index and occurrence. A retry returns the same receipt. Distinct source identities remain separate even with identical bytes or URLs. The snapshot stays deferred and immutable: no release, thumbnail, AI, crawl, embeddings, rule or webhook is admitted. Private staged originals remain retained and count toward quota in addition to target copies. Legacy import APIs are unchanged.",
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

registry.registerPath({
  operationId: "getImportProcessing",
  method: "get",
  path: "/import/reservations/{id}/processing",
  tags,
  security,
  summary: "Read the owner-controlled processing stage and progress",
  request: { params: id },
  responses: {
    200: {
      description:
        "Held, queued, running, waiting_ai, complete or failed; derived preview only when ready.",
      content: json(zImportProcessingView.nullable()),
    },
    ...errors,
  },
});
registry.registerPath({
  operationId: "releaseImportProcessing",
  method: "post",
  path: "/import/reservations/{id}/release",
  tags,
  security,
  summary:
    "Release bounded verified media through an explicit cumulative stage",
  description:
    "Requires imports:readwrite. Native link/text, PDF and originals over 50 MiB are rejected before queuing; raising ingestion limits does not raise preview limits. Images support preview -> search -> local_check -> catalog; videos support preview/search only. requestId is an immutable UUID; expectedGeneration prevents stale transitions. Source fields remain retained. local_check runs local admission only; catalog requires enforced hybrid routing. Failed steps need explicit retry. Ordinary crawler, OCR, embeddings, rules and webhooks remain disabled. Read-only mode rejects writes.",
  request: {
    params: id,
    body: { required: true, content: json(zReleaseImport) },
  },
  responses: {
    200: {
      description: "Durable intent; work is performed asynchronously.",
      content: json(zImportProcessingView.nullable()),
    },
    ...errors,
  },
});
