CREATE TABLE `mediaAiRequests` (
	`id` text PRIMARY KEY NOT NULL,
	`bookmarkId` text NOT NULL,
	`userId` text NOT NULL,
	`day` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mediaAiRequests_day_idx` ON `mediaAiRequests` (`day`);--> statement-breakpoint
ALTER TABLE `bookmarks` ADD `mediaAi` text;