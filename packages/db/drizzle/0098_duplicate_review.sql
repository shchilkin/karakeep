CREATE TABLE `assetContentHashes` (
	`assetId` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`sha256` text,
	`size` integer NOT NULL,
	`status` text NOT NULL,
	`verifiedAt` integer NOT NULL,
	FOREIGN KEY (`assetId`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `assetContentHashes_owner_digest_idx` ON `assetContentHashes` (`userId`,`sha256`,`size`);--> statement-breakpoint
CREATE TABLE `assetHashScanLease` (
	`id` integer PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`expiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `duplicateDecisions` (
	`groupId` text PRIMARY KEY NOT NULL,
	`evidenceVersion` text NOT NULL,
	`decision` text NOT NULL,
	`primaryBookmarkId` text,
	`version` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`groupId`) REFERENCES `duplicateGroups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`primaryBookmarkId`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `duplicateGroups` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `duplicateGroups_userId_sha256_size_unique` ON `duplicateGroups` (`userId`,`sha256`,`size`);