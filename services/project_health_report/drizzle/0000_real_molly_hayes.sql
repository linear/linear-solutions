CREATE TABLE `project_initiatives` (
	`project_id` text NOT NULL,
	`initiative_id` text NOT NULL,
	`initiative_name` text NOT NULL,
	PRIMARY KEY(`project_id`, `initiative_id`)
);
--> statement-breakpoint
CREATE TABLE `project_snapshots` (
	`project_id` text NOT NULL,
	`snapshot_date` text NOT NULL,
	`timestamp` text NOT NULL,
	`completion` real NOT NULL,
	`weighted_completion` real,
	`current_health` text NOT NULL,
	`target_date` text,
	`latest_update_date` text,
	`open_issue_count` integer NOT NULL,
	`started_issue_count` integer NOT NULL,
	`completed_issue_count` integer NOT NULL,
	`overdue_milestone_count` integer NOT NULL,
	`blocked_issue_count` integer NOT NULL,
	PRIMARY KEY(`project_id`, `snapshot_date`)
);
--> statement-breakpoint
CREATE INDEX `project_snapshots_date_idx` ON `project_snapshots` (`snapshot_date`);--> statement-breakpoint
CREATE TABLE `project_teams` (
	`project_id` text NOT NULL,
	`team_id` text NOT NULL,
	PRIMARY KEY(`project_id`, `team_id`)
);
--> statement-breakpoint
CREATE TABLE `project_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`health` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `project_updates_project_date_idx` ON `project_updates` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `projects_current` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`status` text NOT NULL,
	`status_type` text NOT NULL,
	`lead_name` text,
	`reported_health` text,
	`completion` real NOT NULL,
	`weighted_completion` real,
	`target_date` text,
	`latest_update_date` text,
	`open_issue_count` integer NOT NULL,
	`started_issue_count` integer NOT NULL,
	`completed_issue_count` integer NOT NULL,
	`blocked_issue_count` integer NOT NULL,
	`high_priority_issue_count` integer NOT NULL,
	`overdue_milestone_count` integer NOT NULL,
	`payload_json` text NOT NULL,
	`refreshed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_current_status_idx` ON `projects_current` (`status_type`);--> statement-breakpoint
CREATE TABLE `refresh_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`project_count` integer DEFAULT 0 NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`parent_id` text,
	`refreshed_at` text NOT NULL
);
