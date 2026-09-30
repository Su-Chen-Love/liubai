CREATE TABLE `inbox_entries` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`body` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`plan_token` text,
	`created_at` text NOT NULL,
	`processed_at` text,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_inbox_owner_state` ON `inbox_entries` (`owner`,`state`);--> statement-breakpoint
CREATE TABLE `organizer_profiles` (
	`owner` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`last_check` text,
	`last_result` text DEFAULT '尚未检查' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_changes` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`entry_id` text NOT NULL,
	`kind` text NOT NULL,
	`before_data` text,
	`after_data` text NOT NULL,
	`reason` text NOT NULL,
	`automatic` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	PRIMARY KEY(`owner`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_changes_owner_entry` ON `task_changes` (`owner`,`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_changes_owner_state` ON `task_changes` (`owner`,`state`);