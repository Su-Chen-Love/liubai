CREATE TABLE `agent_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`request_id` text NOT NULL,
	`generation` integer NOT NULL,
	`token_hash` text NOT NULL,
	`lease_until` text NOT NULL,
	`state` text DEFAULT 'leased' NOT NULL,
	`created_at` text NOT NULL,
	`finished_at` text,
	`result` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_owner_state` ON `agent_jobs` (`owner`,`state`);--> statement-breakpoint
CREATE INDEX `idx_jobs_owner_request` ON `agent_jobs` (`owner`,`request_id`);--> statement-breakpoint
CREATE TABLE `organizer_grants` (
	`owner` text PRIMARY KEY NOT NULL,
	`account_key` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`backup_enabled` integer DEFAULT 0 NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizer_grants_account_key_unique` ON `organizer_grants` (`account_key`);--> statement-breakpoint
CREATE TABLE `task_imports` (
	`owner` text NOT NULL,
	`id` text NOT NULL,
	`data` text NOT NULL,
	`state` text DEFAULT 'preview' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner`, `id`)
);
