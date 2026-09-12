CREATE TABLE `importReservations` (
	`userId` text NOT NULL,
	`idempotencyKey` text NOT NULL,
	`payloadDigest` text NOT NULL,
	`sourceRevisionId` text NOT NULL,
	PRIMARY KEY(`userId`, `idempotencyKey`),
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sourceRevisionId`) REFERENCES `importSourceRevisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `importSourceAttachments` (
	`sourceRevisionId` text NOT NULL,
	`slot` text NOT NULL,
	`assetId` text NOT NULL,
	`stageName` text,
	`state` text NOT NULL,
	`detectedMime` text,
	`storedSha256` text,
	`storedSize` integer,
	`storageGeneration` text,
	`verifiedAt` integer,
	PRIMARY KEY(`sourceRevisionId`, `slot`),
	FOREIGN KEY (`sourceRevisionId`) REFERENCES `importSourceRevisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `importSourceAttachments_assetId_unique` ON `importSourceAttachments` (`assetId`);--> statement-breakpoint
CREATE TABLE `importSourceObjects` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`provider` text NOT NULL,
	`accountScope` text NOT NULL,
	`objectId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `importSourceObjects_userId_provider_accountScope_objectId_unique` ON `importSourceObjects` (`userId`,`provider`,`accountScope`,`objectId`);--> statement-breakpoint
CREATE TABLE `importSourceRevisions` (
	`id` text PRIMARY KEY NOT NULL,
	`sourceObjectId` text NOT NULL,
	`userId` text NOT NULL,
	`revision` text NOT NULL,
	`payloadDigest` text NOT NULL,
	`payload` text NOT NULL,
	`metadataRaw` text,
	`state` text NOT NULL,
	`fencingToken` integer NOT NULL,
	`leaseUntil` integer NOT NULL,
	`bookmarkId` text NOT NULL,
	`receipt` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`sourceObjectId`) REFERENCES `importSourceObjects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `importSourceRevisions_owner_state_idx` ON `importSourceRevisions` (`userId`,`state`);--> statement-breakpoint
CREATE UNIQUE INDEX `importSourceRevisions_sourceObjectId_revision_unique` ON `importSourceRevisions` (`sourceObjectId`,`revision`);--> statement-breakpoint
CREATE TABLE `processingOutbox` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`sourceRevisionId` text NOT NULL,
	`bookmarkId` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`policyRevision` integer NOT NULL,
	`contentRevision` integer NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sourceRevisionId`) REFERENCES `importSourceRevisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bookmarkId`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `processingOutbox_sourceRevisionId_unique` ON `processingOutbox` (`sourceRevisionId`);--> statement-breakpoint
ALTER TABLE `bookmarks` ADD `processingPolicy` text DEFAULT 'automatic' NOT NULL;--> statement-breakpoint
ALTER TABLE `bookmarks` ADD `policyRevision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `bookmarks` ADD `contentRevision` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
-- The pilot has no policy-upgrade API. SQL barriers also protect stale apply paths.
CREATE TRIGGER deferred_bookmark_update BEFORE UPDATE ON bookmarks
WHEN OLD.processingPolicy = 'deferred'
BEGIN SELECT RAISE(ABORT, 'Deferred imported snapshot is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER deferred_bookmark_delete BEFORE DELETE ON bookmarks
WHEN OLD.processingPolicy = 'deferred'
BEGIN SELECT RAISE(ABORT, 'Deferred imported snapshot is retained'); END;
--> statement-breakpoint
CREATE TRIGGER deferred_asset_update BEFORE UPDATE ON assets
WHEN EXISTS (SELECT 1 FROM bookmarks WHERE id IN (OLD.bookmarkId, NEW.bookmarkId) AND processingPolicy = 'deferred')
BEGIN SELECT RAISE(ABORT, 'Deferred imported original is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER retained_import_asset_delete BEFORE DELETE ON assets
WHEN EXISTS (SELECT 1 FROM importSourceAttachments WHERE assetId = OLD.id)
BEGIN SELECT RAISE(ABORT, 'Imported original is retained'); END;
--> statement-breakpoint
CREATE TRIGGER deferred_asset_subtype_update BEFORE UPDATE ON bookmarkAssets
WHEN EXISTS (SELECT 1 FROM bookmarks WHERE id = OLD.id AND processingPolicy = 'deferred')
BEGIN SELECT RAISE(ABORT, 'Deferred imported snapshot is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER deferred_list_attachment BEFORE INSERT ON bookmarksInLists
WHEN EXISTS (SELECT 1 FROM bookmarks WHERE id = NEW.bookmarkId AND processingPolicy = 'deferred')
BEGIN SELECT RAISE(ABORT, 'Deferred imported snapshots remain private'); END;
--> statement-breakpoint
CREATE TRIGGER deferred_tag_attachment BEFORE INSERT ON tagsOnBookmarks
WHEN EXISTS (SELECT 1 FROM importSourceRevisions WHERE bookmarkId = NEW.bookmarkId AND state = 'committed')
BEGIN SELECT RAISE(ABORT, 'Deferred imported tags are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER deferred_tag_delete BEFORE DELETE ON tagsOnBookmarks
WHEN EXISTS (SELECT 1 FROM bookmarks WHERE id = OLD.bookmarkId AND processingPolicy = 'deferred')
BEGIN SELECT RAISE(ABORT, 'Deferred imported tags are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER deferred_tag_update BEFORE UPDATE ON tagsOnBookmarks
WHEN EXISTS (SELECT 1 FROM bookmarks WHERE id IN (OLD.bookmarkId, NEW.bookmarkId) AND processingPolicy = 'deferred')
BEGIN SELECT RAISE(ABORT, 'Deferred imported tags are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER deferred_tag_name_update BEFORE UPDATE OF name ON bookmarkTags
WHEN NEW.name IS NOT OLD.name AND EXISTS (
  SELECT 1 FROM tagsOnBookmarks JOIN bookmarks ON bookmarks.id = tagsOnBookmarks.bookmarkId
  WHERE tagsOnBookmarks.tagId = OLD.id AND bookmarks.processingPolicy = 'deferred'
)
BEGIN SELECT RAISE(ABORT, 'Deferred imported tag names are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER retained_import_user_delete BEFORE DELETE ON user
WHEN EXISTS (SELECT 1 FROM importSourceRevisions WHERE userId = OLD.id)
BEGIN SELECT RAISE(ABORT, 'Imported source snapshots require retention-aware cleanup'); END;
