import { useState } from "react";
import { useActivity, type ActivityDay } from "../hooks/useActivity";
import {
  LEVEL_THRESHOLDS,
  heatmapRange,
  heatmapWeeks,
  minutesLevel,
  monthLabels,
} from "../lib/heatmap";
import "./ActivityHeatmap.css";

// Contribution-style daily activity heatmap (#54): weeks as columns, weekdays
// as rows (Monday-first, matching the TaskForm chips), one cell per LOCAL day
// over the last 26 weeks. Intensity = tracked minutes quantized into 5 levels
// (lib/heatmap.ts); the cell colors are a validated one-hue ordinal ramp on
// the dark panel surface. Reveal mechanism per the issue's sanctioned option:
// native `title` on hover plus a visible readout line that follows keyboard
// focus, hover, and tap — floating per-cell panels would clip against the
// horizontal scroll container, which the skyline avoids only via heavy
// padding. Every cell carries the full data in its `aria-label`, so the
// readout is presentation-only (aria-hidden) and screen readers hear each
// cell exactly once.

type Totals = ActivityDay["totals"];

const EMPTY_TOTALS: Totals = { started: 0, completed: 0, minutes: 0, xp: 0 };

/** Sparse row labels — Mon/Wed/Fri orient without crowding 14px rows. */
const WEEKDAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""];

const LEVEL_HINTS = [
  "no activity",
  `under ${LEVEL_THRESHOLDS[0]} min`,
  `${LEVEL_THRESHOLDS[0]}–${LEVEL_THRESHOLDS[1] - 1} min`,
  `${LEVEL_THRESHOLDS[1]}–${LEVEL_THRESHOLDS[2] - 1} min`,
  `${LEVEL_THRESHOLDS[2]}+ min`,
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Today as a LOCAL date string — heatmap days are local calendar days. */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "2026-07-15" → local Date (date-only strings without Z parse as local). */
function formatDay(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00`).toLocaleDateString([], {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatMonth(key: string): string {
  // January carries the year — the one label that says which year a scroll
  // through 26 weeks has crossed into (skyline axis precedent).
  const d = new Date(`${key}-01T00:00:00`);
  return d.toLocaleDateString([], d.getMonth() === 0 ? { month: "short", year: "numeric" } : { month: "short" });
}

function cellText(date: string, t: Totals): string {
  return `${formatDay(date)}: ${t.minutes} min tracked, ${t.completed} completed, +${t.xp} XP`;
}

export function ActivityHeatmap() {
  const today = localToday();
  const { from, to } = heatmapRange(today);
  const activity = useActivity(from, to);
  // Last inspected day (focus, hover, or tap) — drives the readout line.
  const [inspected, setInspected] = useState<string | null>(null);

  const totalsByDate = new Map((activity.data?.days ?? []).map((d) => [d.date, d.totals]));
  const weeks = heatmapWeeks(from, to);
  const labels = monthLabels(weeks);

  return (
    <section style={{ marginTop: 24 }}>
      <h3>Daily activity</h3>
      <div className="panel">
        {activity.isError ? (
          <p style={{ color: "var(--text-dim)" }}>
            Couldn't load activity ({activity.error.message}).{" "}
            <button onClick={() => activity.refetch()}>Retry</button>
          </p>
        ) : !activity.data ? (
          <p style={{ color: "var(--text-dim)" }}>Loading…</p>
        ) : (
          <>
            <div className="hm-scroll">
              <div className="hm-months" aria-hidden="true">
                {labels.map((label, i) => (
                  <span key={i} className="hm-month">
                    {label ? formatMonth(label) : ""}
                  </span>
                ))}
              </div>
              <div className="hm-body">
                <div className="hm-weekdays" aria-hidden="true">
                  {WEEKDAY_LABELS.map((label, i) => (
                    <span key={i}>{label}</span>
                  ))}
                </div>
                {weeks.map((week, wi) => (
                  <div key={wi} className="hm-week">
                    {week.map((date, di) => {
                      if (date === null) {
                        // Outside [from, today] — invisible placeholder keeps
                        // the weekday rows aligned in the partial last column.
                        return <span key={di} className="hm-cell placeholder" aria-hidden="true" />;
                      }
                      const totals = totalsByDate.get(date) ?? EMPTY_TOTALS;
                      const text = cellText(date, totals);
                      return (
                        <div
                          key={date}
                          role="button"
                          tabIndex={0}
                          aria-label={text}
                          title={text}
                          className={`hm-cell level-${minutesLevel(totals.minutes)} ${date === today ? "today" : ""}`}
                          onFocus={() => setInspected(date)}
                          onMouseEnter={() => setInspected(date)}
                          onClick={() => setInspected(date)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setInspected(date);
                            }
                          }}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
            <div className="hm-footer">
              {/* The visible half of the reveal: cells write here on focus/hover/tap. */}
              <span className="hm-readout" aria-hidden="true">
                {inspected
                  ? cellText(inspected, totalsByDate.get(inspected) ?? EMPTY_TOTALS)
                  : "Hover or focus a day for details"}
              </span>
              <span className="hm-legend" aria-hidden="true">
                Less
                {LEVEL_HINTS.map((hint, level) => (
                  <span key={level} className={`hm-cell level-${level}`} title={hint} />
                ))}
                More
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
