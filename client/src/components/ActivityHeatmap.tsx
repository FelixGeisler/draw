import { useMemo, useRef, useState } from "react";
import { useActivity, type ActivityDay } from "../hooks/useActivity";
import {
  LEVEL_THRESHOLDS,
  activityLevel,
  heatmapRange,
  heatmapWeeks,
  monthLabels,
} from "../lib/heatmap";
import { addDays, formatDay, localToday } from "../lib/localDay";
import "./ActivityHeatmap.css";

// Contribution-style daily activity heatmap (#54): weeks as columns, weekdays
// as rows (Monday-first, matching the TaskForm chips), one cell per LOCAL day
// over the last 26 weeks. Intensity = tracked minutes quantized into 5 levels,
// floored at level 1 for any day with a card laid — a timer-less completion
// must not render as an empty cell (lib/heatmap.ts, PR #72 review); the cell
// colors are a validated one-hue ordinal ramp on the dark panel surface.
// Keyboard model: one tab stop for the whole grid (roving tabindex, the
// GitHub contribution-graph pattern) with arrow keys moving day by day —
// 182 individual tab stops would make the grid a keyboard wall (PR #72
// review). Reveal mechanism per the issue's sanctioned option: native `title`
// on hover plus a visible readout line that follows keyboard focus, hover,
// and tap — floating per-cell panels would clip against the horizontal
// scroll container, which the skyline avoids only via heavy padding. Every
// cell carries the full data in its `aria-label`, so the readout is
// presentation-only (aria-hidden) and screen readers hear each cell exactly
// once.

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

/** Arrow-key day deltas: columns are weeks, so horizontal moves jump 7 days. */
const KEY_DELTAS = new Map([
  ["ArrowUp", -1],
  ["ArrowDown", 1],
  ["ArrowLeft", -7],
  ["ArrowRight", 7],
]);

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
  // Roving tabindex: the one cell that is the grid's tab stop. Starts on
  // today (the cell a returning user cares about), then follows focus.
  const [active, setActive] = useState(today);
  const gridRef = useRef<HTMLDivElement>(null);

  // Derived layout is memoized so hover/focus state changes (which re-render
  // this component per cell entered) don't rebuild the grid math each time
  // (PR #72 review). `from`/`to`/`today` are plain strings — stable deps.
  const totalsByDate = useMemo(
    () => new Map((activity.data?.days ?? []).map((d) => [d.date, d.totals])),
    [activity.data],
  );
  const weeks = useMemo(() => heatmapWeeks(from, to), [from, to]);
  const labels = useMemo(() => monthLabels(weeks), [weeks]);

  // Arrow keys move the focused cell day by day; Home/End jump to the range
  // ends. One handler on the grid (the cells' events bubble here).
  const onGridKeyDown = (e: React.KeyboardEvent) => {
    const delta = KEY_DELTAS.get(e.key);
    const target =
      delta !== undefined ? addDays(active, delta) : e.key === "Home" ? from : e.key === "End" ? to : null;
    if (target === null) return;
    e.preventDefault(); // handled key — never scroll the page, even at an edge
    if (target < from || target > to) return;
    setActive(target);
    setInspected(target);
    gridRef.current?.querySelector<HTMLElement>(`[data-date="${target}"]`)?.focus();
  };

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
              <div
                className="hm-body"
                role="grid"
                aria-label="Daily activity, one cell per day"
                ref={gridRef}
                onKeyDown={onGridKeyDown}
              >
                <div className="hm-weekdays" aria-hidden="true">
                  {WEEKDAY_LABELS.map((label, i) => (
                    <span key={i}>{label}</span>
                  ))}
                </div>
                {weeks.map((week, wi) => (
                  <div key={wi} className="hm-week" role="row">
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
                          role="gridcell"
                          data-date={date}
                          tabIndex={date === active ? 0 : -1}
                          aria-label={text}
                          title={text}
                          className={`hm-cell level-${activityLevel(totals)} ${date === today ? "today" : ""}`}
                          onFocus={() => {
                            // Clicks and programmatic focus land here too, so
                            // the tab stop always follows the real focus.
                            setActive(date);
                            setInspected(date);
                          }}
                          onMouseEnter={() => setInspected(date)}
                          onClick={() => setInspected(date)}
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
