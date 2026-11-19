CREATE TABLE `practice_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`course_key` text NOT NULL,
	`lesson_key` text DEFAULT '' NOT NULL,
	`exercise_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`exercise_snapshot` text NOT NULL,
	`answer` text NOT NULL,
	`correct` integer,
	`grading` text NOT NULL,
	`feedback` text DEFAULT '' NOT NULL,
	`advisory` integer DEFAULT 0 NOT NULL,
	`owner_note` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `practice_attempts_scope` ON `practice_attempts` (`course_key`,`lesson_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `practice_attempts_exercise` ON `practice_attempts` (`course_key`,`lesson_key`,`exercise_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `sidecar_assessment_answers` (
	`assessment_id` text NOT NULL,
	`item_id` text NOT NULL,
	`answer` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`assessment_id`, `item_id`),
	FOREIGN KEY (`assessment_id`) REFERENCES `sidecar_assessments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `sidecar_assessment_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sidecar_assessment_items` (
	`id` text PRIMARY KEY NOT NULL,
	`assessment_id` text NOT NULL,
	`position` integer NOT NULL,
	`lesson_key` text DEFAULT '' NOT NULL,
	`exercise_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`exercise_snapshot` text NOT NULL,
	FOREIGN KEY (`assessment_id`) REFERENCES `sidecar_assessments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sidecar_assessment_items_pos` ON `sidecar_assessment_items` (`assessment_id`,`position`);--> statement-breakpoint
CREATE TABLE `sidecar_assessment_results` (
	`id` text PRIMARY KEY NOT NULL,
	`assessment_id` text NOT NULL,
	`item_id` text NOT NULL,
	`answer` text,
	`correct` integer,
	`grading` text NOT NULL,
	`feedback` text DEFAULT '' NOT NULL,
	`advisory` integer DEFAULT 0 NOT NULL,
	`owner_note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`assessment_id`) REFERENCES `sidecar_assessments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `sidecar_assessment_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sidecar_assessment_results_item` ON `sidecar_assessment_results` (`assessment_id`,`item_id`);--> statement-breakpoint
CREATE TABLE `sidecar_assessments` (
	`id` text PRIMARY KEY NOT NULL,
	`course_key` text NOT NULL,
	`title` text NOT NULL,
	`mode` text NOT NULL,
	`duration_seconds` integer,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`deadline_at` integer,
	`submitted_at` integer,
	`finalized_at` integer,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sidecar_assessments_course` ON `sidecar_assessments` (`course_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `sidecar_tutor_lessons` (
	`hash` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sidecar_tutor_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`course_key` text NOT NULL,
	`lesson_key` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`lesson_hash` text NOT NULL,
	`context_meta` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`lesson_hash`) REFERENCES `sidecar_tutor_lessons`(`hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sidecar_tutor_scope` ON `sidecar_tutor_turns` (`course_key`,`lesson_key`,`created_at`);