import { fetchLinearHierarchy } from "./linear";
import { ensureSchema, saveRefresh } from "./store";

export type HealthEnv = {
  DB: D1Database;
  LINEAR_API_KEY?: string;
  LINEAR_ROOT_TEAM?: string;
  DASHBOARD_TIMEZONE?: string;
  UPDATE_FRESHNESS_DAYS?: string;
  CRON_SECRET?: string;
};

export function settings(env: HealthEnv) {
  const parsedFreshness = Number(env.UPDATE_FRESHNESS_DAYS ?? "7");
  return {
    rootTeam: env.LINEAR_ROOT_TEAM?.trim() || "Graphing",
    timezone: env.DASHBOARD_TIMEZONE?.trim() || "America/Los_Angeles",
    freshnessDays: Number.isFinite(parsedFreshness) && parsedFreshness > 0 ? parsedFreshness : 7,
  };
}

export async function refreshLinearData(env: HealthEnv, snapshot: boolean) {
  if (!env.LINEAR_API_KEY) throw new Error("LINEAR_API_KEY is not configured");
  await ensureSchema(env.DB);
  const config = settings(env);
  const now = new Date();
  const runId = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO refresh_runs(id,kind,started_at,status,project_count) VALUES (?,?,?,?,0)`)
    .bind(runId, snapshot ? "daily" : "hourly", now.toISOString(), "running").run();
  try {
    const result = await fetchLinearHierarchy({
      apiKey: env.LINEAR_API_KEY,
      rootTeamName: config.rootTeam,
      freshnessDays: config.freshnessDays,
      now,
    });
    await saveRefresh(env.DB, result.teams, result.projects, { snapshot, timezone: config.timezone, now });
    await env.DB.prepare(`UPDATE refresh_runs SET finished_at=?,status='succeeded',project_count=? WHERE id=?`)
      .bind(new Date().toISOString(), result.projects.length, runId).run();
    return { projectCount: result.projects.length, teamCount: result.teams.length, snapshot, generatedAt: now.toISOString() };
  } catch (error) {
    await env.DB.prepare(`UPDATE refresh_runs SET finished_at=?,status='failed',error=? WHERE id=?`)
      .bind(new Date().toISOString(), error instanceof Error ? error.message : String(error), runId).run();
    throw error;
  }
}
