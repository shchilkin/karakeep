CREATE TABLE `importLocalCheckBatches` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`selectionKey` text NOT NULL,
	`status` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `importLocalCheckBatches_user_idx` ON `importLocalCheckBatches` (`userId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `importLocalCheckItems` (
	`batchId` text NOT NULL,
	`bookmarkId` text NOT NULL,
	`sourceRevisionId` text NOT NULL,
	`requestId` text NOT NULL,
	`generation` integer NOT NULL,
	`policyRevision` integer NOT NULL,
	`contentRevision` integer NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	PRIMARY KEY(`batchId`, `bookmarkId`),
	FOREIGN KEY (`batchId`) REFERENCES `importLocalCheckBatches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `importLocalCheckItems_state_idx` ON `importLocalCheckItems` (`state`,`batchId`);
