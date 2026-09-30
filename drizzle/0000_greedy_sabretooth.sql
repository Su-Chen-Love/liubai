CREATE TABLE `spaces` (
	`owner` text PRIMARY KEY NOT NULL,
	`initialized` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text NOT NULL,
	`owner` text NOT NULL,
	`data` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_owner_deleted` ON `tasks` (`owner`,`deleted`);