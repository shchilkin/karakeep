CREATE TABLE `imageSetMembers` (
	`setId` text NOT NULL,
	`bookmarkId` text PRIMARY KEY NOT NULL,
	`assetId` text NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`setId`) REFERENCES `imageSets`(`bookmarkId`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bookmarkId`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`assetId`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `imageSetMembers_set_position_idx` ON `imageSetMembers` (`setId`,`position`);--> statement-breakpoint
CREATE TABLE `imageSets` (
	`bookmarkId` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`coverBookmarkId` text NOT NULL,
	FOREIGN KEY (`bookmarkId`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE cascade
);
