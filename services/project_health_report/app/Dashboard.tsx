"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, ArrowDownRight, ArrowRight, ArrowUpRight, CalendarDays, Check, ChevronDown,
  CircleDot, Clock3, ExternalLink, Filter, Flag, Gauge, Layers3, Minus, RefreshCw, Search, SlidersHorizontal,
  Sparkles, TrendingUp, TriangleAlert, X,
} from "lucide-react";
import type { DashboardData, Health, ProjectRecord, SnapshotPoint } from "@/lib/types";

type Filters = { team: string; status: string; initiative: string; lead: string; health: string; from: string; to: string; search: string };
const initialFilters: Filters = { team: "all", status: "all", initiative: "all", lead: "all", health: "all", from: "", to: "", search: "" };
type ListMode = "all" | "done" | "inProgress" | "backlog" | "paused" | "canceled" | "noLead" | "noStatus" | "complete" | "onTrack" | "risk" | "fresh" | "stale" | "movers" | "stalled" | "regressed" | "overdue" | "blocked";

const healthLabel: Record<Health, string> = { onTrack: "On track", atRisk: "At risk", offTrack: "Off track", noUpdate: "No current update" };
const modeLabel: Record<ListMode, string> = {
  all: "All filtered projects", done: "Done projects", inProgress: "In-progress projects", backlog: "Backlog / to-do projects", paused: "Paused projects",
  canceled: "Canceled projects", noLead: "Projects without a lead", noStatus: "Projects without a status",
  complete: "Newly at 100%", onTrack: "On-track projects", risk: "At-risk / off-track",
  fresh: "Fresh green updates", stale: "Missing or stale updates", movers: "Top movers", stalled: "Stalled projects",
  regressed: "Regressed projects", overdue: "Overdue projects or milestones", blocked: "Priority or blocked work",
};

function daysAgo(value: string | null) {
  if (!value) return null;
  return Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
}
function shortDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(`${value.slice(0, 10)}T12:00:00`));
}
function delta(value: number, suffix = " pts") {
  if (value === 0) return <span className="delta neutral"><Minus size={12} />0{suffix}</span>;
  const positive = value > 0;
  return <span className={`delta ${positive ? "positive" : "negative"}`}>{positive ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}{Math.abs(value)}{suffix}</span>;
}
function HealthPill({ health }: { health: Health }) {
  return <span className={`health-pill ${health}`}><span className="health-dot" />{healthLabel[health]}</span>;
}

function SelectFilter({ label, value, options, onChange, activeOption = false }: { label: string; value: string; options: string[]; onChange: (value: string) => void; activeOption?: boolean }) {
  return <label className="select-filter"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}>{activeOption && <option value="active">Active</option>}<option value="all">All</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select><ChevronDown size={13} /></label>;
}

/** Canvas cannot resolve var(), so chart colors are read off :root at draw time. */
function themeColor(token: string, fallback: string) {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || fallback;
}

function useCanvas(draw: (context: CanvasRenderingContext2D, width: number, height: number) => void, deps: unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      canvas.width = rect.width * scale; canvas.height = rect.height * scale;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(scale, scale); context.clearRect(0, 0, rect.width, rect.height); draw(context, rect.width, rect.height);
    };
    render();
    const observer = new ResizeObserver(render); observer.observe(canvas);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return ref;
}

function LineChart({ points }: { points: SnapshotPoint[] }) {
  const ref = useCanvas((ctx, width, height) => {
    const accent = themeColor("--accent", "#3f6ea8");
    const pad = { x: 24, top: 18, bottom: 24 }; const chartH = height - pad.top - pad.bottom;
    ctx.strokeStyle = themeColor("--line", "#dfe4ec"); ctx.lineWidth = 1;
    [0, .5, 1].forEach((row) => { const y = pad.top + chartH * row; ctx.beginPath(); ctx.moveTo(pad.x, y); ctx.lineTo(width - 8, y); ctx.stroke(); });
    if (points.length < 2) return;
    const min = Math.min(...points.map((p) => p.averageCompletion)) - 3; const max = Math.max(...points.map((p) => p.averageCompletion)) + 3;
    const xy = points.map((point, i) => ({ x: pad.x + (i / (points.length - 1)) * (width - pad.x - 10), y: pad.top + (1 - (point.averageCompletion - min) / Math.max(1, max - min)) * chartH }));
    const gradient = ctx.createLinearGradient(0, pad.top, 0, height - pad.bottom); gradient.addColorStop(0, `${accent}2e`); gradient.addColorStop(1, `${accent}00`);
    ctx.beginPath(); ctx.moveTo(xy[0].x, height - pad.bottom); xy.forEach((p) => ctx.lineTo(p.x, p.y)); ctx.lineTo(xy.at(-1)!.x, height - pad.bottom); ctx.closePath(); ctx.fillStyle = gradient; ctx.fill();
    ctx.beginPath(); xy.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
    const last = xy.at(-1)!; ctx.beginPath(); ctx.arc(last.x, last.y, 4, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.stroke();
  }, [points]);
  return <canvas className="trend-canvas" ref={ref} aria-label="Average completion trend" />;
}

function HealthChart({ points }: { points: SnapshotPoint[] }) {
  const ref = useCanvas((ctx, width, height) => {
    const top = 16, bottom = 24, chartH = height - top - bottom; const barW = Math.max(3, (width - 16) / Math.max(1, points.length));
    const keys: Array<[keyof SnapshotPoint, string]> = [["onTrack", "#56a683"], ["atRisk", "#e2a23a"], ["offTrack", "#d66365"], ["noUpdate", "#c3ccd9"]];
    points.forEach((point, i) => { let y = top + chartH; keys.forEach(([key, color]) => { const h = (Number(point[key]) / 100) * chartH; ctx.fillStyle = color; ctx.fillRect(8 + i * barW, y - h, Math.max(2, barW - 1), h); y -= h; }); });
  }, [points]);
  return <canvas className="trend-canvas" ref={ref} aria-label="Project health distribution trend" />;
}

function BarChart({ points, field, token, fallback }: { points: SnapshotPoint[]; field: "completedProjects" | "targetDateChanges"; token: string; fallback: string }) {
  const weekly = useMemo(() => points.reduce<number[]>((weeks, point, index) => { const bucket = Math.floor(index / 7); weeks[bucket] = (weeks[bucket] ?? 0) + point[field]; return weeks; }, []), [points, field]);
  const ref = useCanvas((ctx, width, height) => {
    const color = themeColor(token, fallback); const label = themeColor("--muted", "#6b7482");
    const max = Math.max(1, ...weekly); const gap = 12; const barW = (width - gap * (weekly.length + 1)) / Math.max(1, weekly.length);
    weekly.forEach((value, i) => { const h = ((height - 40) * value) / max; const x = gap + i * (barW + gap); const y = height - 24 - h; ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, Math.max(8, barW), h, 4); ctx.fill(); ctx.fillStyle = label; ctx.font = "11px sans-serif"; ctx.textAlign = "center"; ctx.fillText(`W${i + 1}`, x + barW / 2, height - 7); });
  }, [weekly, token, fallback]);
  return <canvas className="trend-canvas compact" ref={ref} aria-label={`${field} by week`} />;
}

function TrendCard({ title, value, sub, legend, children, onClick }: { title: string; value: string; sub: string; legend?: React.ReactNode; children: React.ReactNode; onClick: () => void }) {
  return <button className="trend-card" onClick={onClick}><div className="card-heading"><div><p>{title}</p><div className="trend-value">{value}</div></div><span>{sub}<ArrowRight size={14} /></span></div>{legend}<div className="canvas-wrap">{children}</div></button>;
}

function AttentionCard({ icon, title, count, detail, projects, tone, onClick }: { icon: React.ReactNode; title: string; count: number; detail: string; projects: ProjectRecord[]; tone: string; onClick: () => void }) {
  return <button className="attention-card" onClick={onClick}><div className={`attention-icon ${tone}`}>{icon}</div><div className="attention-copy"><div><strong>{title}</strong><span>{detail}</span></div><div className="attention-count">{count}</div></div><div className="mini-projects">{projects.slice(0, 3).map((project) => <span key={project.id}><i style={{ width: `${Math.max(14, project.completion)}%` }} />{project.name}<b>{project.delta7d > 0 ? `+${project.delta7d}` : project.delta7d} pts</b></span>)}</div></button>;
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState(initialFilters); const [mode, setMode] = useState<ListMode>("all"); const [filtersOpen, setFiltersOpen] = useState(false);
  const load = useCallback(async () => { setLoading(true); setError(""); try { const response = await fetch("/api/dashboard", { cache: "no-store" }); const payload = await response.json() as DashboardData & { error?: string }; if (!response.ok) throw new Error(payload.error || "Could not load dashboard"); setData(payload); } catch (err) { setError(err instanceof Error ? err.message : "Could not load dashboard"); } finally { setLoading(false); } }, []);
  useEffect(() => {
    let active = true;
    fetch("/api/dashboard", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as DashboardData & { error?: string };
        if (!response.ok) throw new Error(payload.error || "Could not load dashboard");
        if (active) setData(payload);
      })
      .catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : "Could not load dashboard"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const base = useMemo(() => data?.projects.filter((project) => {
    const search = filters.search.toLowerCase();
    return (filters.team === "all" || project.teams.includes(filters.team)) && (filters.status === "all" || (filters.status === "active" ? !["completed", "canceled"].includes(project.statusType) : project.status === filters.status)) &&
      (filters.initiative === "all" || project.initiatives.includes(filters.initiative)) && (filters.lead === "all" || project.lead === filters.lead) &&
      (filters.health === "all" || project.health === filters.health) && (!filters.from || (project.targetDate && project.targetDate >= filters.from)) &&
      (!filters.to || (project.targetDate && project.targetDate <= filters.to)) && (!search || [project.name, project.lead, ...project.teams, ...project.initiatives].join(" ").toLowerCase().includes(search));
  }) ?? [], [data, filters]);
  const modeProjects = useMemo(() => {
    const nowDay = new Date().toISOString().slice(0, 10);
    const predicates: Record<ListMode, (project: ProjectRecord) => boolean> = {
      all: () => true, done: (p) => p.statusType === "completed", inProgress: (p) => p.statusType === "started",
      backlog: (p) => p.statusType === "backlog" || p.statusType === "planned", paused: (p) => p.statusType === "paused", canceled: (p) => p.statusType === "canceled",
      noLead: (p) => !p.lead, noStatus: (p) => !p.status || p.statusType === "unknown",
      complete: (p) => p.completedInLast7Days, onTrack: (p) => p.health === "onTrack", risk: (p) => p.health === "atRisk" || p.health === "offTrack",
      fresh: (p) => p.health === "onTrack" && (daysAgo(p.latestUpdateDate) ?? 99) <= (data?.freshnessDays ?? 7), stale: (p) => p.health === "noUpdate",
      movers: (p) => p.delta7d > 0, stalled: (p) => p.stalled, regressed: (p) => p.delta7d < 0 || p.healthDowngrade || p.targetDateChangeDays > 0,
      overdue: (p) => Boolean((p.targetDate && p.targetDate < nowDay) || p.overdueMilestoneCount), blocked: (p) => p.blockedIssueCount > 0 || p.highPriorityIssueCount > 0,
    };
    return base.filter(predicates[mode]).sort((a, b) => mode === "movers" ? b.delta7d - a.delta7d : a.name.localeCompare(b.name));
  }, [base, mode, data]);
  const openList = (next: ListMode) => { setMode(next); requestAnimationFrame(() => document.getElementById("project-list")?.scrollIntoView({ behavior: "smooth", block: "start" })); };

  if (loading) return <main className="state-page"><div className="loading-mark"><span /><span /><span /></div><h1>Building the health report</h1><p>Loading projects, updates, and trend snapshots…</p><div className="loading-grid">{Array.from({ length: 6 }, (_, i) => <i key={i} />)}</div></main>;
  if (error) return <main className="state-page"><div className="state-icon error"><AlertCircle size={24} /></div><h1>Project health is unavailable</h1><p>{error}</p><button className="primary-button" onClick={() => void load()}><RefreshCw size={15} />Try again</button></main>;
  if (!data || !data.projects.length) return <main className="state-page"><div className="state-icon"><Layers3 size={24} /></div><h1>No projects found</h1><p>The Graphing hierarchy resolved successfully, but it does not contain any projects.</p></main>;

  const currentTrend = data.trends.at(-1); const averageCompletion = base.length ? Math.round(base.reduce((sum, p) => sum + p.completion, 0) / base.length) : 0;
  const count = (predicate: (p: ProjectRecord) => boolean) => base.filter(predicate).length;
  const stale = count((p) => p.health === "noUpdate");
  const done = count((p) => p.statusType === "completed");
  const inProgress = count((p) => p.statusType === "started");
  const backlog = count((p) => p.statusType === "backlog" || p.statusType === "planned");
  const paused = count((p) => p.statusType === "paused");
  const canceled = count((p) => p.statusType === "canceled");
  const noLead = count((p) => !p.lead);
  const noStatus = count((p) => !p.status || p.statusType === "unknown");
  const movers = [...base].filter((p) => p.delta7d > 0).sort((a, b) => b.delta7d - a.delta7d);
  const stalled = base.filter((p) => p.stalled); const regressed = base.filter((p) => p.delta7d < 0 || p.healthDowngrade || p.targetDateChangeDays > 0);
  const overdue = base.filter((p) => Boolean((p.targetDate && p.targetDate < new Date().toISOString().slice(0, 10)) || p.overdueMilestoneCount));
  const blocked = base.filter((p) => p.blockedIssueCount || p.highPriorityIssueCount);

  return <main className="dashboard-shell">
    <header className="topbar"><div className="brand"><span className="brand-glyph"><Gauge size={17} /></span><span>Project Health</span><i /></div><div className="topbar-actions"><span className="sync-state"><i />Updated {new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(data.generatedAt))}</span><button aria-label="Refresh dashboard" onClick={() => void load()}><RefreshCw size={15} /></button><div className="avatar">G</div></div></header>
    <div className="page">
      {data.source === "demo" && <div className="demo-banner"><Sparkles size={15} /><span><strong>Preview mode</strong> — connect a Linear API key to replace this representative data.</span><a href="#setup">Setup</a></div>}
      <section className="title-row"><div><div className="eyebrow"><span>Workspace</span><ArrowRight size={12} /><span>{data.rootTeam}</span></div><h1>Project Health Report</h1><p>{data.rootTeam} and {data.teams.length - 1} descendant teams · All projects</p></div><div className="title-meta"><div className="avatar-stack"><span>MC</span><span>AK</span><span>PS</span><span>+{Math.max(0, data.leads.length - 3)}</span></div><button className="outline-button" onClick={() => setFiltersOpen(!filtersOpen)}><SlidersHorizontal size={15} />Filters{Object.values(filters).some((v) => v && v !== "all") && <b />}</button></div></section>
      <section className={`filter-bar ${filtersOpen ? "open" : ""}`}><div className="search-box"><Search size={14} /><input aria-label="Search projects" placeholder="Search projects…" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} />{filters.search && <button onClick={() => setFilters({ ...filters, search: "" })}><X size={13} /></button>}</div><div className="selects"><SelectFilter label="Team" value={filters.team} options={data.teams} onChange={(team) => setFilters({ ...filters, team })} /><SelectFilter label="Status" value={filters.status} options={data.statuses} activeOption onChange={(status) => setFilters({ ...filters, status })} /><SelectFilter label="Initiative" value={filters.initiative} options={data.initiatives} onChange={(initiative) => setFilters({ ...filters, initiative })} /><SelectFilter label="Lead" value={filters.lead} options={data.leads} onChange={(lead) => setFilters({ ...filters, lead })} /><SelectFilter label="Health" value={filters.health} options={["onTrack", "atRisk", "offTrack", "noUpdate"]} onChange={(health) => setFilters({ ...filters, health })} /></div><div className="date-filters"><label>Target from<input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></label><label>to<input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></label><button onClick={() => { setFilters(initialFilters); setMode("all"); }}>Clear</button></div></section>

      <section><div className="section-heading"><div><span>Linear project status</span><h2>Portfolio overview</h2></div><p>Counts reflect the active filters</p></div><div className="kpi-grid status-grid">
        <button onClick={() => openList("all")} className="kpi-card"><div className="kpi-icon blue"><Layers3 size={16} /></div><span>Total projects</span><strong>{base.length}</strong><span className="kpi-change muted">Across {data.teams.length} teams</span></button>
        <button onClick={() => openList("done")} className="kpi-card"><div className="kpi-icon green"><Check size={16} /></div><span>Done</span><strong>{done}</strong><span className="kpi-change muted">Completed status</span></button>
        <button onClick={() => openList("inProgress")} className="kpi-card"><div className="kpi-icon blue"><CircleDot size={16} /></div><span>In progress</span><strong>{inProgress}</strong><span className="kpi-change muted">Started or in review</span></button>
        <button onClick={() => openList("backlog")} className="kpi-card"><div className="kpi-icon amber"><Clock3 size={16} /></div><span>Backlog / to do</span><strong>{backlog}</strong><span className="kpi-change muted">Not started</span></button>
        <button onClick={() => openList("paused")} className="kpi-card"><div className="kpi-icon gray"><Minus size={16} /></div><span>Paused</span><strong>{paused}</strong><span className="kpi-change muted">Paused status</span></button>
        <button onClick={() => openList("canceled")} className="kpi-card"><div className="kpi-icon gray"><X size={16} /></div><span>Canceled</span><strong>{canceled}</strong><span className="kpi-change muted">Canceled status</span></button>
        <button onClick={() => openList("noLead")} className="kpi-card"><div className="kpi-icon amber"><Flag size={16} /></div><span>No assignee</span><strong>{noLead}</strong><span className="kpi-change muted">No project lead</span></button>
        <button onClick={() => openList("noStatus")} className="kpi-card"><div className="kpi-icon gray"><AlertCircle size={16} /></div><span>No project status</span><strong>{noStatus}</strong><span className="kpi-change muted">Missing Linear status</span></button>
      </div></section>

      <section><div className="section-heading"><div><span>Historical trends</span><h2>Momentum over time</h2></div><p>{data.trends.length} daily snapshots</p></div><div className="trend-grid">
        <TrendCard title="Average completion" value={`${currentTrend?.averageCompletion ?? averageCompletion}%`} sub="View projects" onClick={() => openList("all")}><LineChart points={data.trends} /></TrendCard>
        <TrendCard title="Health distribution" value={`${currentTrend?.onTrack ?? 0}% on track`} sub="View health" onClick={() => openList("risk")} legend={<div className="legend"><span className="onTrack">On track</span><span className="atRisk">At risk</span><span className="offTrack">Off track</span><span className="noUpdate">No update</span></div>}><HealthChart points={data.trends} /></TrendCard>
        <TrendCard title="Completed projects" value={`${data.trends.slice(-7).reduce((sum, p) => sum + p.completedProjects, 0)} this week`} sub="View complete" onClick={() => openList("complete")}><BarChart points={data.trends} field="completedProjects" token="--accent" fallback="#3f6ea8" /></TrendCard>
        <TrendCard title="Target-date changes" value={`${data.trends.slice(-7).reduce((sum, p) => sum + p.targetDateChanges, 0)} this week`} sub="View changes" onClick={() => openList("regressed")}><BarChart points={data.trends} field="targetDateChanges" token="--amber" fallback="#bb7a15" /></TrendCard>
      </div></section>

      <section><div className="section-heading"><div><span>Attention & movement</span><h2>What changed</h2></div><p>Signals worth a closer look</p></div><div className="attention-grid">
        <AttentionCard icon={<TrendingUp size={17} />} title="Top movers" count={movers.length} detail="Largest positive 7-day delta" projects={movers} tone="blue" onClick={() => openList("movers")} />
        <AttentionCard icon={<Minus size={17} />} title="Stalled" count={stalled.length} detail="No completion change for 14 days" projects={stalled} tone="gray" onClick={() => openList("stalled")} />
        <AttentionCard icon={<ArrowDownRight size={17} />} title="Regressed" count={regressed.length} detail="Progress, health, or target date" projects={regressed} tone="red" onClick={() => openList("regressed")} />
        <AttentionCard icon={<CalendarDays size={17} />} title="Overdue" count={overdue.length} detail="Projects or milestones past due" projects={overdue} tone="amber" onClick={() => openList("overdue")} />
        <AttentionCard icon={<Flag size={17} />} title="Priority & blocked" count={blocked.length} detail="Open urgent, high, or blocked issues" projects={blocked} tone="red" onClick={() => openList("blocked")} />
        <AttentionCard icon={<Clock3 size={17} />} title="Needs an update" count={stale} detail={`No update in ${data.freshnessDays}+ days`} projects={base.filter((p) => p.health === "noUpdate")} tone="gray" onClick={() => openList("stale")} />
      </div></section>

      <section id="project-list" className="table-section"><div className="table-heading"><div><span>Project drill-down</span><h2>{modeLabel[mode]}</h2></div><div><span>{modeProjects.length} projects</span>{mode !== "all" && <button onClick={() => setMode("all")}><X size={13} />Clear view</button>}<button><Filter size={13} />Columns</button></div></div>
        {modeProjects.length ? <div className="table-wrap"><table><thead><tr><th>Project</th><th>Health</th><th>Completion</th><th>7d</th><th>Target</th><th>Change</th><th>Latest update</th><th>Issues O / S / B</th><th>Milestones</th></tr></thead><tbody>{modeProjects.map((project) => <tr key={project.id}><td><a href={project.url} target="_blank" rel="noreferrer"><span className="project-mark" style={{ background: project.health === "onTrack" ? "#dff3ea" : project.health === "atRisk" ? "#fbecd1" : project.health === "offTrack" ? "#f9dddd" : "#e4eaf3" }}>{project.name.slice(0, 1)}</span><span><strong>{project.name}<ExternalLink size={11} /></strong><small>{project.lead ?? "No lead"} · {project.teams.join(", ")}<br />{project.initiatives.join(", ") || "No initiative"}</small></span></a></td><td><HealthPill health={project.health} /></td><td><div className="progress-cell"><span><i style={{ width: `${project.completion}%` }} /></span><b>{project.completion}%</b>{project.weightedCompletion !== null && <small>{project.weightedCompletion}% weighted</small>}</div></td><td>{delta(project.delta7d, "")}</td><td><span className={project.targetDate && project.targetDate < new Date().toISOString().slice(0, 10) ? "overdue-date" : ""}>{shortDate(project.targetDate)}</span></td><td>{project.targetDateChangeDays ? <span className={project.targetDateChangeDays > 0 ? "slip" : "positive"}>{project.targetDateChangeDays > 0 ? "+" : ""}{project.targetDateChangeDays}d</span> : "—"}</td><td><span className={project.health === "noUpdate" ? "stale-date" : ""}>{project.latestUpdateDate ? `${daysAgo(project.latestUpdateDate)}d ago` : "Never"}</span></td><td><span className="issue-counts"><b>{project.openIssueCount}</b><b>{project.startedIssueCount}</b><b className={project.blockedIssueCount ? "blocked" : ""}>{project.blockedIssueCount}</b></span></td><td>{project.overdueMilestoneCount ? <span className="milestone-badge"><TriangleAlert size={12} />{project.overdueMilestoneCount} overdue</span> : <span className="clear-status"><Check size={12} />Clear</span>}</td></tr>)}</tbody></table></div> : <div className="empty-list"><Search size={21} /><strong>No projects in this view</strong><span>Try clearing a filter or selecting another dashboard signal.</span><button onClick={() => { setMode("all"); setFilters(initialFilters); }}>Show all projects</button></div>}
      </section>
      <footer id="setup"><span>Project Health Report</span><p>Read-only Linear GraphQL · Hourly refresh · Daily snapshots · {data.timezone}</p></footer>
    </div>
  </main>;
}
