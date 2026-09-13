CREATE TABLE `mediaAiBatches` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`status` text NOT NULL,
	`provider` text NOT NULL,
	`request` text NOT NULL,
	`entries` text NOT NULL,
	`createdAt` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mediaAiBatches_user_idx` ON `mediaAiBatches` (`userId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `mediaAiControl` (
	`id` integer PRIMARY KEY NOT NULL,
	`cloudMode` text NOT NULL,
	`dailyRequests` integer NOT NULL,
	`revision` integer NOT NULL,
	`updatedAt` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mediaAiRuns` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`bookmarkId` text NOT NULL,
	`createdAt` text NOT NULL,
	`completedAt` text,
	`snapshot` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bookmarkId`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mediaAiRuns_bookmark_idx` ON `mediaAiRuns` (`bookmarkId`,`createdAt`);