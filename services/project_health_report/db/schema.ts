import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  key: text("key").notNull(),
  parentId: text("parent_id"),
  refreshedAt: text("refreshed_at").notNull(),
});

export const projectsCurrent = sqliteTable("projects_current", {
  id: text("id").primaryKey(), name: text("name").notNull(), url: text("url").notNull(),
  status: text("status").notNull(), statusType: text("status_type").notNull(), leadName: text("lead_name"),
  reportedHealth: text("reported_health"), completion: real("completion").notNull(), weightedCompletion: real("weighted_completion"),
  targetDate: text("target_date"), latestUpdateDate: text("latest_update_date"), openIssueCount: integer("open_issue_count").notNull(),
  startedIssueCount: integer("started_issue_count").notNull(), completedIssueCount: integer("completed_issue_count").notNull(),
  blockedIssueCount: integer("blocked_issue_count").notNull(), highPriorityIssueCount: integer("high_priority_issue_count").notNull(),
  overdueMilestoneCount: integer("overdue_milestone_count").notNull(), payloadJson: text("payload_json").notNull(),
  refreshedAt: text("refreshed_at").notNull(),
}, (table) => [index("projects_current_status_idx").on(table.statusType)]);

export const projectTeams = sqliteTable("project_teams", {
  projectId: text("project_id").notNull(), teamId: text("team_id").notNull(),
}, (table) => [primaryKey({ columns: [table.projectId, table.teamId] })]);

export const projectInitiatives = sqliteTable("project_initiatives", {
  projectId: text("project_id").notNull(), initiativeId: text("initiative_id").notNull(), initiativeName: text("initiative_name").notNull(),
}, (table) => [primaryKey({ columns: [table.projectId, table.initiativeId] })]);

export const projectUpdates = sqliteTable("project_updates", {
  id: text("id").primaryKey(), projectId: text("project_id").notNull(), health: text("health").notNull(),
  body: text("body").notNull(), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (table) => [index("project_updates_project_date_idx").on(table.projectId, table.createdAt)]);

export const projectSnapshots = sqliteTable("project_snapshots", {
  projectId: text("project_id").notNull(), snapshotDate: text("snapshot_date").notNull(), timestamp: text("timestamp").notNull(),
  completion: real("completion").notNull(), weightedCompletion: real("weighted_completion"), currentHealth: text("current_health").notNull(),
  targetDate: text("target_date"), latestUpdateDate: text("latest_update_date"), openIssueCount: integer("open_issue_count").notNull(),
  startedIssueCount: integer("started_issue_count").notNull(), completedIssueCount: integer("completed_issue_count").notNull(),
  overdueMilestoneCount: integer("overdue_milestone_count").notNull(), blockedIssueCount: integer("blocked_issue_count").notNull(),
}, (table) => [primaryKey({ columns: [table.projectId, table.snapshotDate] }), index("project_snapshots_date_idx").on(table.snapshotDate)]);

export const refreshRuns = sqliteTable("refresh_runs", {
  id: text("id").primaryKey(), kind: text("kind").notNull(), startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"), status: text("status").notNull(), projectCount: integer("project_count").notNull().default(0), error: text("error"),
});
