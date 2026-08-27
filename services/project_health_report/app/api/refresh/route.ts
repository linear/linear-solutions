import { env } from "cloudflare:workers";
import { NextRequest, NextResponse } from "next/server";
import { refreshLinearData, type HealthEnv } from "@/server/refresh";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const runtime = env as unknown as HealthEnv;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!runtime.CRON_SECRET || supplied !== runtime.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const snapshot = request.nextUrl.searchParams.get("snapshot") === "true";
    return NextResponse.json(await refreshLinearData(runtime, snapshot));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Refresh failed" }, { status: 502 });
  }
}
