CREATE TABLE `importProcessing` (
	`bookmarkId` text PRIMARY KEY NOT NULL,
	`sourceRevisionId` text NOT NULL,
	`userId` text NOT NULL,
	`requestId` text NOT NULL,
	`stage` text NOT NULL,
	`state` text NOT NULL,
	`generation` integer NOT NULL,
	`policyRevision` integer NOT NULL,
	`contentRevision` integer NOT NULL,
	`previewAssetId` text NOT NULL,
	`originalWidth` integer,
	`originalHeight` integer,
	`previewReady` integer DEFAULT false NOT NULL,
	`searchReady` integer DEFAULT false NOT NULL,
	`aiRunId` text,
	`leaseToken` text,
	`leaseUntil` integer DEFAULT 0 NOT NULL,
	`error` text,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`bookmarkId`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sourceRevisionId`) REFERENCES `importSourceRevisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `importProcessing_sourceRevisionId_unique` ON `importProcessing` (`sourceRevisionId`);--> statement-breakpoint
CREATE UNIQUE INDEX `importProcessing_previewAssetId_unique` ON `importProcessing` (`previewAssetId`);--> statement-breakpoint
CREATE INDEX `importProcessing_state_updatedAt_idx` ON `importProcessing` (`state`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `importProcessing_leaseUntil_idx` ON `importProcessing` (`leaseUntil`);
--> statement-breakpoint
-- Retention remains independent of processing. Only the AI projection may change.
DROP TRIGGER deferred_bookmark_update;
--> statement-breakpoint
CREATE TRIGGER deferred_bookmark_update BEFORE UPDATE ON bookmarks
WHEN OLD.processingPolicy = 'deferred' AND (
  NEW."id" IS NOT OLD."id" OR
  NEW."createdAt" IS NOT OLD."createdAt" OR
  NEW."lastSavedAt" IS NOT OLD."lastSavedAt" OR
  NEW."title" IS NOT OLD."title" OR
  NEW."titleSource" IS NOT OLD."titleSource" OR
  NEW."sensitiveCategories" IS NOT OLD."sensitiveCategories" OR
  NEW."archived" IS NOT OLD."archived" OR
  NEW."favourited" IS NOT OLD."favourited" OR
  NEW."userId" IS NOT OLD."userId" OR
  NEW."processingPolicy" IS NOT OLD."processingPolicy" OR
  NEW."policyRevision" IS NOT OLD."policyRevision" OR
  NEW."contentRevision" IS NOT OLD."contentRevision" OR
  NEW."taggingStatus" IS NOT OLD."taggingStatus" OR
  NEW."summarizationStatus" IS NOT OLD."summarizationStatus" OR
  NEW."embeddingStatus" IS NOT OLD."embeddingStatus" OR
  NEW."summary" IS NOT OLD."summary" OR
  NEW."note" IS NOT OLD."note" OR
  NEW."type" IS NOT OLD."type" OR
  NEW."source" IS NOT OLD."source"
  OR ((NEW.mediaAi IS NOT OLD.mediaAi OR NEW.modifiedAt IS NOT OLD.modifiedAt) AND NOT EXISTS (SELECT 1 FROM importProcessing p
    WHERE p.bookmarkId = OLD.id AND p.userId = OLD.userId
      AND p.policyRevision = OLD.policyRevision AND p.contentRevision = OLD.contentRevision
      AND p.previewReady = 1 AND p.searchReady = 1
      AND p.stage IN ('local_check', 'catalog') AND p.state IN ('running', 'waiting_ai', 'complete')
      AND p.aiRunId = json_extract(NEW.mediaAi, '$.runId')))
)
BEGIN SELECT RAISE(ABORT, 'Deferred imported source fields are immutable'); END;
--> statement-breakpoint
DROP TRIGGER deferred_tag_attachment;
--> statement-breakpoint
CREATE TRIGGER deferred_tag_attachment BEFORE INSERT ON tagsOnBookmarks
WHEN EXISTS (SELECT 1 FROM importSourceRevisions WHERE bookmarkId = NEW.bookmarkId AND state = 'committed')
AND NOT (NEW.attachedBy = 'ai' AND EXISTS (
  SELECT 1 FROM importProcessing p JOIN bookmarks b ON b.id = p.bookmarkId
  WHERE p.bookmarkId = NEW.bookmarkId AND p.userId = b.userId
    AND p.policyRevision = b.policyRevision AND p.contentRevision = b.contentRevision
    AND p.stage = 'catalog' AND p.state IN ('running', 'waiting_ai')
    AND p.previewReady = 1 AND p.searchReady = 1 AND p.aiRunId = json_extract(b.mediaAi, '$.runId')
    AND json_extract(b.mediaAi, '$.status') IN ('processing', 'processing_local')
))
BEGIN SELECT RAISE(ABORT, 'Deferred imported tags require a catalog permit'); END;
--> statement-breakpoint
DROP TRIGGER retained_import_asset_delete;
--> statement-breakpoint
CREATE TRIGGER retained_import_asset_delete BEFORE DELETE ON assets
WHEN EXISTS (SELECT 1 FROM importSourceAttachments WHERE assetId = OLD.id)
  OR EXISTS (SELECT 1 FROM importProcessing WHERE previewAssetId = OLD.id)
BEGIN SELECT RAISE(ABORT, 'Imported original or preview is retained'); END;

--> statement-breakpoint
-- Existing imports remain held; this migration starts no background work.
INSERT INTO importProcessing (bookmarkId, sourceRevisionId, userId, requestId, stage, state, generation, policyRevision, contentRevision, previewAssetId, updatedAt)
SELECT b.id, r.id, b.userId, lower(hex(randomblob(16))), 'preview', 'held', 0, b.policyRevision, b.contentRevision, lower(hex(randomblob(16))), CAST(strftime('%s','now') AS INTEGER) * 1000
FROM importSourceRevisions r JOIN bookmarks b ON b.id = r.bookmarkId
WHERE r.state = 'committed' AND b.processingPolicy = 'deferred';
