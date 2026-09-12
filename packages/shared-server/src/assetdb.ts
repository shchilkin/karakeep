import type { DB } from "@karakeep/db";
import { db } from "@karakeep/db";
import { and, eq, gt } from "drizzle-orm";
import {
  importSourceRevisions,
  importProcessing,
  importSourceAttachments,
} from "@karakeep/db/schema";
import { isImportAssetRetained } from "./processingPolicy";
import type { AssetMetadata, AssetStore } from "@karakeep/shared/assetdb";
import { PluginManager, PluginType } from "@karakeep/shared/plugins";
import type { QuotaApproved } from "@karakeep/shared/storageQuota";

import { loadAllPlugins } from "./plugins";

export {
  ASSET_TYPES,
  IMAGE_ASSET_TYPES,
  SUPPORTED_ASSET_TYPES,
  SUPPORTED_BOOKMARK_ASSET_TYPES,
  SUPPORTED_UPLOAD_ASSET_TYPES,
  VIDEO_ASSET_TYPES,
  zAssetMetadataSchema,
} from "@karakeep/shared/assetdb";
export type {
  AssetInfo,
  AssetMetadata,
  AssetStore,
} from "@karakeep/shared/assetdb";

async function getAssetStore(): Promise<AssetStore> {
  await loadAllPlugins();
  const store = await PluginManager.getClient(PluginType.AssetStore);
  if (!store) {
    throw new Error("No asset store plugin is registered");
  }
  return store;
}

export function newAssetId() {
  return crypto.randomUUID();
}

/** Dedicated write path for an authorized, unfinished derived preview. Ordinary
 * save/delete paths continue to reject retained originals and previews. */
export async function saveImportPreview(
  database: DB,
  claim: { bookmarkId: string; generation: number; leaseToken: string },
  asset: Buffer,
  quotaApproved: QuotaApproved,
) {
  const current = database
    .select()
    .from(importProcessing)
    .where(
      and(
        eq(importProcessing.bookmarkId, claim.bookmarkId),
        eq(importProcessing.generation, claim.generation),
        eq(importProcessing.leaseToken, claim.leaseToken),
        gt(importProcessing.leaseUntil, Date.now()),
        eq(importProcessing.previewReady, false),
        eq(importProcessing.state, "running"),
      ),
    )
    .get();
  if (
    !current ||
    quotaApproved.userId !== current.userId ||
    quotaApproved.approvedSize < asset.length ||
    database
      .select()
      .from(importSourceAttachments)
      .where(eq(importSourceAttachments.assetId, current.previewAssetId))
      .get()
  )
    throw new Error("Import preview write is not authorized");
  const store = await getAssetStore();
  return store.saveAsset({
    userId: current.userId,
    assetId: current.previewAssetId,
    asset,
    metadata: { contentType: "image/webp", fileName: "import-preview.webp" },
  });
}

export async function saveAsset({
  userId,
  assetId,
  asset,
  metadata,
  quotaApproved,
}: {
  userId: string;
  assetId: string;
  asset: Buffer;
  metadata: AssetMetadata;
  quotaApproved: QuotaApproved;
}) {
  if (quotaApproved.userId !== userId) {
    throw new Error("Quota approval is for a different user");
  }
  if (quotaApproved.approvedSize < asset.byteLength) {
    throw new Error("Asset size exceeds approved quota");
  }

  if (isImportAssetRetained(db, assetId))
    throw new Error("Imported original is retained and immutable");
  const store = await getAssetStore();
  return store.saveAsset({ userId, assetId, asset, metadata });
}

export async function saveAssetFromFile({
  userId,
  assetId,
  assetPath,
  metadata,
  quotaApproved,
}: {
  userId: string;
  assetId: string;
  assetPath: string;
  metadata: AssetMetadata;
  quotaApproved: QuotaApproved;
}) {
  if (quotaApproved.userId !== userId) {
    throw new Error("Quota approval is for a different user");
  }

  if (isImportAssetRetained(db, assetId))
    throw new Error("Imported original is retained and immutable");
  const store = await getAssetStore();
  return store.saveAssetFromFile({ userId, assetId, assetPath, metadata });
}

export async function readAsset({
  userId,
  assetId,
  start,
  end,
}: {
  userId: string;
  assetId: string;
  start?: number;
  end?: number;
}) {
  const store = await getAssetStore();
  return store.readAsset({ userId, assetId, start, end });
}

export async function createAssetReadStream({
  userId,
  assetId,
  start,
  end,
}: {
  userId: string;
  assetId: string;
  start?: number;
  end?: number;
}) {
  const store = await getAssetStore();
  return store.createAssetReadStream({ userId, assetId, start, end });
}

export async function readAssetMetadata({
  userId,
  assetId,
}: {
  userId: string;
  assetId: string;
}) {
  const store = await getAssetStore();
  return store.readAssetMetadata({ userId, assetId });
}

export async function getAssetSize({
  userId,
  assetId,
}: {
  userId: string;
  assetId: string;
}) {
  const store = await getAssetStore();
  return store.getAssetSize({ userId, assetId });
}

export async function silentDeleteAsset(
  userId: string,
  assetId: string | undefined,
) {
  if (assetId) {
    await deleteAsset({ userId, assetId }).catch(() => ({}));
  }
}

export async function deleteAsset({
  userId,
  assetId,
}: {
  userId: string;
  assetId: string;
}) {
  if (isImportAssetRetained(db, assetId))
    throw new Error("Imported original is retained and immutable");
  const store = await getAssetStore();
  return store.deleteAsset({ userId, assetId });
}

export async function deleteUserAssets({
  userId,
  database = db,
}: {
  userId: string;
  database?: DB;
}) {
  if (
    database
      .select({ id: importSourceRevisions.id })
      .from(importSourceRevisions)
      .where(eq(importSourceRevisions.userId, userId))
      .limit(1)
      .get()
  )
    throw new Error(
      "Imported snapshots require a retention-aware account cleanup",
    );
  const store = await getAssetStore();
  return store.deleteUserAssets({ userId });
}

export async function* getAllAssets() {
  const store = await getAssetStore();
  yield* store.getAllAssets();
}
