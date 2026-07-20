import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { useGamification } from "../hooks/useGamification";
import { AchievementCard } from "../components/AchievementCard";
import { HistoryCalendar } from "../components/HistoryCalendar";
import { biasStatement } from "../lib/estimationCoach";
import { partitionAchievements } from "../lib/achievementEdit";
import { collapseAchievementChains } from "../lib/achievementChains";

// The estimation block is summary-only since #155 (ADR-41): the server no
// longer ships a per-task array, and the page must not want one back.
interface Estimation {
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
    taskCount: number;
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
  const { summary, byCategory } = estimation;

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
              {/* Coaching statements (#55): only categories with enough
                  qualifying tasks in range get a line — biasStatement returns
                  null below the minimum sample, and nothing renders then. */}
              {byCategory.flatMap((c) => {
                const statement = biasStatement(c);
                return statement === null
                  ? []
                  : [
                      <p
                        key={c.categoryId}
                        data-testid="bias-statement"
                        style={{ color: ratioColor(c.ratio), fontSize: 13, margin: "8px 0 0" }}
                      >
                        {statement}
                      </p>,
                    ];
              })}
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

/**
 * The achievement collection (#124, extended #177, #183): a card set, not a panel
 * grid — earned cards face-up with their art and date, unearned ones face-down
 * with a progress bar, so the shelf shows both what you have and what is left to
 * collect. Each card is name-only on the face; the description reveals on
 * hover/focus, and an ✎ button opens an inline editor to rename/rewrite/hide it
 * (display only — unlock/claim/XP untouched, ADR-44). Hidden cards move OUT of
 * the main grid into a collapsed "Hidden (N)" section — still editable,
 * claimable, and un-hideable there.
 *
 * A CHAIN (#156) collapses to a single evolving card via
 * collapseAchievementChains (ADR-48): only the current tier shows — the first
 * unclaimed level, or the maxed level once all are claimed. Claiming advances it
 * with no extra code (useClaimAchievement invalidates ['gamification']; the
 * refetch drops the just-claimed tier and the next becomes current). One-offs
 * render standalone. The heading counts the COLLAPSED view (one per chain +
 * one-offs), a chain "collected" once any tier of it has unlocked — derived from
 * the payload, never asserted on in E2E.
 */
function AchievementsGrid() {
  const { data } = useGamification();
  if (!data) return null;
  const collapsed = collapseAchievementChains(data.achievements);
  const collected = collapsed.filter((c) => c.collected).length;
  const { visible, hidden } = partitionAchievements(collapsed.map((c) => c.card));
  return (
    <section style={{ marginTop: 24 }}>
      <h3>
        Achievements{" "}
        <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>
          — {collected}/{collapsed.length} collected
        </span>
      </h3>
      <div className="ach-collection">
        {visible.map((a) => (
          <AchievementCard key={a.key} achievement={a} claimable editable />
        ))}
      </div>

      {hidden.length > 0 && (
        <details className="ach-hidden-section">
          <summary>Hidden ({hidden.length})</summary>
          <div className="ach-collection" style={{ marginTop: 12 }}>
            {hidden.map((a) => (
              <AchievementCard key={a.key} achievement={a} claimable editable />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

export function StatsPage() {
  const [range, setRange] = useState<Range>("week");
  const { from, to } = rangeDates(range);
  const stats = useQuery({
    queryKey: ["stats", from, to],
    queryFn: () => api.get<Stats>(`/api/stats?from=${from}&to=${to}`),
    // Range-chip toggles change the queryKey; without this the page body
    // unmounts to nothing while the new range fetches. Same idiom as
    // useActivity's widening (#53).
    placeholderData: keepPreviousData,
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
        </>
      )}

      {/* Independent of the stats query AND the week/month toggle (the
          heatmap's old guarantee, kept through #155/#174): the History
          calendar is the page's activity view with its own multi-week
          /api/activity window, and the achievements grid reads
          /api/gamification — a failing or refetching stats query must never
          take either down with it. */}
      <HistoryCalendar />

      <AchievementsGrid />
    </div>
  );
}
