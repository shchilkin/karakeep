import { z } from "zod";
import { normalizeTagName } from "../utils/tag";

export const IMPORT_CONTRACT_VERSION = "deferred-copy-v1";
// Absolute protocol ceiling; the server applies its lower configured admission limit.
export const MAX_IMPORT_FILE_BYTES = 4096 * 1024 * 1024;
// Preview still buffers the original. Raising ingestion limits must not raise this.
export const MAX_IMPORT_PREVIEW_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_METADATA_BYTES = 4 * 1024 * 1024;
export const zImportDigest = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().min(1).max(512);
const sourceUrl = z
  .url()
  .max(8192)
  .refine((v) => /^https?:\/\//.test(v));
const nativeContent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("link"), url: sourceUrl }).strict(),
  z
    .object({
      type: z.literal("text"),
      text: z
        .string()
        .min(1)
        .max(100_000)
        .refine((v) => v.trim().length > 0),
    })
    .strict(),
]);
const evidence = z
  .object({
    sha256: zImportDigest,
    size: z.number().int().positive().max(MAX_IMPORT_FILE_BYTES),
  })
  .strict();
export const zImportReservation = z
  .object({
    contractVersion: z.literal(IMPORT_CONTRACT_VERSION),
    source: z
      .object({
        provider: key,
        accountScope: key,
        objectId: key,
        revision: key,
        revisionKind: z.enum(["current", "historical"]),
      })
      .strict(),
    metadata: z
      .object({
        sha256: zImportDigest,
        size: z.number().int().positive().max(MAX_IMPORT_METADATA_BYTES),
      })
      .strict(),
    mapping: z
      .object({
        title: z.string().max(2000).nullable(),
        note: z.string().max(100_000).nullable(),
        sourceUrl: z
          .url()
          .max(8192)
          .refine((v) => /^https?:\/\//.test(v))
          .nullable(),
        savedAt: z.iso.datetime().nullable(),
        tags: z
          .array(
            z
              .string()
              .min(1)
              .max(200)
              .refine((tag) => normalizeTagName(tag).trim().length > 0),
          )
          .max(100),
      })
      .strict(),
    completeness: z.enum(["unknown", "partial", "complete"]),
    // Absent for legacy asset payloads: do not default, transform or re-digest them.
    content: nativeContent.optional(),
    attachments: z
      .array(
        z
          .object({
            slot: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
            ordinal: z.literal(0),
            role: z.literal("original"),
            originalName: z.string().min(1).max(1024),
            observed: evidence,
            exported: evidence.nullable(),
            transport: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .max(1),
    processingPolicy: z.literal("deferred"),
    storageMode: z.literal("copy"),
  })
  .strict()
  .refine((v) => v.attachments.length === (v.content ? 0 : 1), {
    path: ["attachments"],
    message: "Native content has no original; an asset requires exactly one.",
  });
export type ImportReservationInput = z.infer<typeof zImportReservation>;
export const zImportFence = z
  .object({ fencingToken: z.number().int().positive() })
  .strict();
export interface ImportReceipt {
  operationId: string;
  sourceRevisionId: string;
  bookmarkId: string;
  assets: {
    slot: string;
    assetId: string;
    storedSha256: string;
    storedSize: number;
    storageGeneration: string;
  }[];
  metadataSha256: string;
  metadataSize: number;
  metadataUrl: string;
  processingPolicy: "deferred";
  policyRevision: number;
  contentRevision: number;
  physicalReuse: false;
}

/** Container types accepted by the byte-verified import protocol. */
export const importVideoMimeTypes = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
  "video/x-matroska",
] as const;
export const isImportVideoMime = (mime: string | null | undefined) =>
  importVideoMimeTypes.some((value) => value === mime);
