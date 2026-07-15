import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useGamification } from "../hooks/useGamification";
import { ActivityHeatmap } from "../components/ActivityHeatmap";

interface Estimation {
  tasks: { taskId: number; title: string; estimatedMinutes: number; trackedMinutes: number; ratio: number }[];
  summary: {
    taskCount: number;
    totalEstimatedMinutes: number;
    totalTrackedMinutes: number;
    accuracyRatio: number | null;
    tendency: "under" | "over" | "accurate" | null;
  };
  byCategory: {
    categoryId: number;
    name: string;
    color: string;
    estimatedMinutes: number;
    trackedMinutes: number;
    ratio: number;
  }[];
}

interface Stats {
  totalMinutes: number;
  byCategory: { categoryId: number; name: string; color: string; minutes: number }[];
  byImpact: { impact: number; minutes: number }[];
  byGoal: { goalId: number; title: string; minutes: number }[];
  completed: { count: number; avgEffortMinutes: number | null };
  estimation: Estimation;
  leverageInsights: string[];
  weeklyGrade: string | null;
}

type Range = "week" | "month";

function rangeDates(range: Range): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - (range === "week" ? 6 : 29));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function Bar({ label, minutes, max, color }: { label: string; minutes: number; max: number; color: string }) {
  const pct = max > 0 ? Math.max(2, (minutes / max) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
      <span style={{ width: 110, textAlign: "right", color: "var(--text-dim)", fontSize: 13 }}>{label}</span>
      <div style={{ flex: 1, background: "var(--bg)", borderRadius: 6, height: 22 }}>
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            borderRadius: 6,
            background: color,
            transition: "width 0.4s",
          }}
        />
      </div>
      <span style={{ width: 70, fontVariantNumeric: "tabular-nums", fontSize: 13 }}>{minutes} min</span>
    </div>
  );
}

const TENDENCY_COPY: Record<string, string> = {
  under: "you under-estimate — tasks take longer than planned. Pad your next estimates.",
  over: "you over-estimate — tasks finish faster than planned.",
  accurate: "your estimates match reality. Trust them.",
};

/** Same band as the server: within 0.9–1.1 counts as accurate. */
function ratioColor(ratio: number): string {
  if (ratio > 1.1) return "var(--danger)";
  if (ratio < 0.9) return "var(--warn)";
  return "var(--ok)";
}

function EstimationSection({ estimation }: { estimation: Estimation }) {
  const { tasks, summary, byCategory } = estimation;
  const maxMinutes = Math.max(1, ...tasks.flatMap((t) => [t.estimatedMinutes, t.trackedMinutes]));

  return (
    <section style={{ marginTop: 24 }}>
      <h3>Estimates vs. reality</h3>
      {summary.accuracyRatio === null ? (
        <div className="panel">
          <p style={{ color: "var(--text-dim)" }}>
            No completed task in this range has both an effort estimate and tracked time.
          </p>
        </div>
      ) : (
        <>
          <div className="panel" style={{ textAlign: "center" }}>
            <div style={{ fontSize: 32, fontWeight: 700, color: ratioColor(summary.accuracyRatio) }}>
              {summary.accuracyRatio}×
            </div>
            <div style={{ color: "var(--text-dim)" }}>
              {summary.tendency && TENDENCY_COPY[summary.tendency]}
            </div>
            <div style={{ color: "var(--text-dim)", fontSize: 13, marginTop: 4 }}>
              {summary.taskCount} task{summary.taskCount === 1 ? "" : "s"} ·{" "}
              {summary.totalEstimatedMinutes} min estimated · {summary.totalTrackedMinutes} min tracked
            </div>
          </div>

          <div className="panel" style={{ marginTop: 12 }}>
            {tasks.map((t) => (
              <div key={t.taskId} style={{ padding: "6px 0" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 14 }}>
                  <span>{t.title}</span>
                  <span style={{ color: ratioColor(t.ratio), fontVariantNumeric: "tabular-nums" }}>
                    {t.ratio}×
                  </span>
                </div>
                <Bar label="estimated" minutes={t.estimatedMinutes} max={maxMinutes} color="#7a8093" />
                <Bar label="tracked" minutes={t.trackedMinutes} max={maxMinutes} color={ratioColor(t.ratio)} />
              </div>
            ))}
          </div>

          {byCategory.length > 0 && (
            <div className="panel" style={{ marginTop: 12 }}>
              {byCategory.map((c) => (
                <div
                  key={c.categoryId}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", fontSize: 13 }}
                >
                  <span style={{ width: 110, textAlign: "right", color: c.color }}>{c.name}</span>
                  <span style={{ flex: 1, color: "var(--text-dim)" }}>
                    {c.estimatedMinutes} min estimated · {c.trackedMinutes} min tracked
                  </span>
                  <span style={{ width: 70, color: ratioColor(c.ratio), fontVariantNumeric: "tabular-nums" }}>
                    {c.ratio}×
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

const GRADE_COLORS: Record<string, string> = {
  A: "#3fbf7f",
  B: "#8fd14f",
  C: "#ffb64f",
  D: "#ff8c5f",
  F: "#ff5f6b",
};

function AchievementsGrid() {
  const { data } = useGamification();
  if (!data) return null;
  return (
    <section style={{ marginTop: 24 }}>
      <h3>Achievements</h3>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: 12,
        }}
      >
        {data.achievements.map((a) => (
          <div
            key={a.key}
            className="panel"
            style={{
              opacity: a.unlockedAt ? 1 : 0.4,
              borderColor: a.unlockedAt ? "var(--warn)" : "var(--border)",
            }}
          >
            <div style={{ fontSize: 22 }}>{a.emoji}</div>
            <div style={{ fontWeight: 600 }}>{a.title}</div>
            <div style={{ color: "var(--text-dim)", fontSize: 13 }}>{a.description}</div>
            {a.unlockedAt && (
              <div style={{ color: "var(--warn)", fontSize: 12, marginTop: 4 }}>
                unlocked {a.unlockedAt.slice(0, 10)}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function StatsPage() {
  const [range, setRange] = useState<Range>("week");
  const { from, to } = rangeDates(range);
  const stats = useQuery({
    queryKey: ["stats", from, to],
    queryFn: () => api.get<Stats>(`/api/stats?from=${from}&to=${to}`),
  });

  const s = stats.data;
  const maxImpact = Math.max(1, ...(s?.byImpact.map((r) => r.minutes) ?? []));
  const maxCat = Math.max(1, ...(s?.byCategory.map((r) => r.minutes) ?? []));
  const lowImpactDominant =
    s && s.totalMinutes > 0
      ? s.byImpact.filter((r) => r.impact <= 2).reduce((a, r) => a + r.minutes, 0) / s.totalMinutes > 0.5
      : false;

  return (
    <div className="content">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ flex: 1 }}>Stats</h1>
        <span
          className={`chip ${range === "week" ? "active" : ""}`}
          style={range === "week" ? { borderColor: "var(--accent)", color: "var(--text)" } : { cursor: "pointer" }}
          onClick={() => setRange("week")}
        >
          Last 7 days
        </span>
        <span
          className={`chip ${range === "month" ? "active" : ""}`}
          style={range === "month" ? { borderColor: "var(--accent)", color: "var(--text)" } : { cursor: "pointer" }}
          onClick={() => setRange("month")}
        >
          Last 30 days
        </span>
      </div>

      {s && (
        <>
          <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
            <div className="panel" style={{ flex: 1, minWidth: 160, textAlign: "center" }}>
              <div style={{ fontSize: 32, fontWeight: 700 }}>{s.totalMinutes}</div>
              <div style={{ color: "var(--text-dim)" }}>minutes tracked</div>
            </div>
            <div className="panel" style={{ flex: 1, minWidth: 160, textAlign: "center" }}>
              <div style={{ fontSize: 32, fontWeight: 700 }}>{s.completed.count}</div>
              <div style={{ color: "var(--text-dim)" }}>tasks completed</div>
            </div>
            <div className="panel" style={{ flex: 1, minWidth: 160, textAlign: "center" }}>
              <div
                style={{
                  fontSize: 32,
                  fontWeight: 700,
                  color: s.weeklyGrade ? GRADE_COLORS[s.weeklyGrade] : "var(--text-dim)",
                }}
              >
                {s.weeklyGrade ?? "–"}
              </div>
              <div style={{ color: "var(--text-dim)" }}>leverage grade</div>
            </div>
          </div>

          {s.leverageInsights.map((insight) => (
            <div
              key={insight}
              className="panel"
              style={{ marginTop: 16, borderColor: "var(--warn)", fontSize: 15 }}
            >
              {insight}
            </div>
          ))}

          <section style={{ marginTop: 24 }}>
            <h3>Where your time went — by impact</h3>
            <div className="panel">
              {s.byImpact.length === 0 && <p style={{ color: "var(--text-dim)" }}>No time tracked yet.</p>}
              {[1, 2, 3, 4, 5].map((impact) => {
                const row = s.byImpact.find((r) => r.impact === impact);
                if (!row) return null;
                const isLow = impact <= 2;
                return (
                  <Bar
                    key={impact}
                    label={"★".repeat(impact)}
                    minutes={row.minutes}
                    max={maxImpact}
                    color={isLow && lowImpactDominant ? "var(--danger)" : isLow ? "#7a8093" : "var(--accent)"}
                  />
                );
              })}
            </div>
          </section>

          <section style={{ marginTop: 24 }}>
            <h3>By category</h3>
            <div className="panel">
              {s.byCategory.length === 0 && <p style={{ color: "var(--text-dim)" }}>No time tracked yet.</p>}
              {s.byCategory.map((r) => (
                <Bar key={r.categoryId} label={r.name} minutes={r.minutes} max={maxCat} color={r.color} />
              ))}
            </div>
          </section>

          {s.byGoal.length > 0 && (
            <section style={{ marginTop: 24 }}>
              <h3>By goal</h3>
              <div className="panel">
                {s.byGoal.map((r) => (
                  <Bar key={r.goalId} label={r.title} minutes={r.minutes} max={maxCat} color="var(--ok)" />
                ))}
              </div>
            </section>
          )}

          <EstimationSection estimation={s.estimation} />

          <AchievementsGrid />
        </>
      )}

      {/* Independent of the stats query and of the week/month toggle: the
          heatmap always shows its 26-week consistency record (#54). */}
      <ActivityHeatmap />
    </div>
  );
}
