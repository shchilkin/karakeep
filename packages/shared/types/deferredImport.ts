import { z } from "zod";
import { normalizeTagName } from "../utils/tag";

export const IMPORT_CONTRACT_VERSION = "deferred-copy-v1";
export const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_METADATA_BYTES = 4 * 1024 * 1024;
export const zImportDigest = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().min(1).max(512);
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
      .length(1),
    processingPolicy: z.literal("deferred"),
    storageMode: z.literal("copy"),
  })
  .strict();
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
