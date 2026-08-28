import { env } from "cloudflare:workers";
import { NextResponse } from "next/server";
import { demoDashboard } from "@/lib/demo-data";
import { refreshLinearData, settings, type HealthEnv } from "@/server/refresh";
import { loadDashboard } from "@/server/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const runtime = env as unknown as HealthEnv;
  if (!runtime.LINEAR_API_KEY) return NextResponse.json(demoDashboard(), { headers: { "Cache-Control": "no-store" } });
  try {
    const config = settings(runtime);
    let data = await loadDashboard(runtime.DB, config);
    if (!data) {
      await refreshLinearData(runtime, true);
      data = await loadDashboard(runtime.DB, config);
    }
    if (!data) throw new Error("The refresh completed without active projects");
    return NextResponse.json(data, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load project health" }, { status: 502 });
  }
}
