import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useActivity, type ActivityCard, type ActivityDay } from "../hooks/useActivity";
import { useCategories } from "../hooks/useTasks";
import { addDays, formatDay, localToday } from "../lib/localDay";
import { buildCalendar, mondayOf, weekdayIndex, type CalCell } from "../lib/historyCalendar";
import { trophyRarity } from "../lib/trophyRarity";
import "./HistoryCalendar.css";

// History contribution calendar (#174): the GitHub-heatmap successor to the
// house-of-cards skyline (#53). One tile per LOCAL day (ADR-21) laid out in
// Monday-first week columns, shaded by activity intensity. The per-day detail
// (which tasks, completed vs worked-but-unfinished, XP, drawn rarity) reveals
// on hover / keyboard focus / tap into a docked panel — a robust successor to
// the skyline's floating card details, immune to edge clipping. The layout and
// derivation are pure (lib/historyCalendar), so this file is DOM + interaction.

/** Weeks shown before "Load earlier" widens the window. */
const WEEKS_PER_WINDOW = 26;
/**
 * Mirror of the server's MAX_RANGE_DAYS cap on GET /api/activity (~10 years):
 * an inclusive [from, to] wider than this 400s. "Load earlier" clamps to it so
 * the client never sends a request the server rejects.
 */
const MAX_RANGE_DAYS = 3653;
/** Monday labels only on rows 1/3/5, GitHub-style, to keep the gutter quiet. */
const WEEKDAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""];

/** The oldest Monday whose window to `today` still fits the inclusive cap. */
function oldestMonday(today: string): string {
  const hardMin = addDays(today, -(MAX_RANGE_DAYS - 1));
  // First Monday on or after the hard floor, so from..today stays within cap.
  return weekdayIndex(hardMin) === 0 ? hardMin : addDays(mondayOf(hardMin), 7);
}

/** Suffix for a card line in the detail panel: outcome + rarity + drawn mark. */
function cardSuffix(c: ActivityCard): { text: string; rarity: string } {
  const rarity = trophyRarity(c);
  if (!c.completed) return { text: "not completed", rarity: "none" };
  const drawn = c.wasDrawn ? " 🃏" : "";
  const tier = rarity !== "none" ? ` · ${rarity}` : "";
  return { text: `+${c.xpAwarded} XP${drawn}${tier}`, rarity };
}

const Cell = memo(function Cell({
  cell,
  col,
  row,
  active,
  pinned,
  onEnter,
  onLeave,
  onToggle,
}: {
  cell: CalCell;
  col: number;
  row: number;
  active: boolean;
  pinned: boolean;
  onEnter: (date: string) => void;
  onLeave: () => void;
  onToggle: (date: string, lowerOnly?: boolean) => void;
}) {
  const place = { gridColumn: col + 2, gridRow: row + 2 };
  if (cell.date === null) {
    return <div className="cal-pad" style={place} aria-hidden="true" />;
  }
  const cls = [
    "cal-cell",
    `lvl-${cell.level}`,
    cell.isToday ? "today" : "",
    active ? "active" : "",
    cell.rarity !== "none" ? `rarity-${cell.rarity}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Empty days carry a native tooltip only — keeping every quiet day out of the
  // tab order (hundreds of them) while staying hover-discoverable.
  if (cell.level === 0) {
    return (
      <div className={cls} style={place} data-cal-day={cell.date} title={formatDay(cell.date)} aria-hidden="true" />
    );
  }

  const t = cell.day!.totals;
  const label = `${formatDay(cell.date)}: ${t.completed} completed, ${t.minutes} min tracked${
    cell.rarity !== "none" ? `, ${cell.rarity}` : ""
  }`;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={pinned}
      aria-label={label}
      className={cls}
      style={place}
      data-cal-day={cell.date}
      onPointerEnter={() => onEnter(cell.date!)}
      onPointerLeave={onLeave}
      onFocus={() => onEnter(cell.date!)}
      onBlur={onLeave}
      onClick={() => onToggle(cell.date!)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle(cell.date!);
        } else if (e.key === "Escape") {
          onToggle(cell.date!, true);
          e.currentTarget.blur();
        }
      }}
    />
  );
});

function Detail({
  cell,
  categoryNames,
}: {
  cell: CalCell | null;
  categoryNames: Map<number, string>;
}) {
  if (!cell || !cell.day) {
    return <div className="cal-detail idle">Hover, focus or tap a day to see what you did.</div>;
  }
  const { day, date, isToday } = cell;
  const t = day.totals;
  return (
    <div className="cal-detail" role="status" data-cal-detail={date!}>
      <div className="cal-detail-date">
        {formatDay(date!)}
        {isToday && <span className="cal-detail-today"> · today</span>}
      </div>
      <div className="cal-detail-totals">
        {t.completed} done · {t.minutes} min tracked
        {t.xp > 0 && ` · +${t.xp} XP`}
      </div>
      <ul className="cal-detail-list">
        {day.cards.map((c) => {
          const s = cardSuffix(c);
          const name = categoryNames.get(c.categoryId);
          return (
            <li key={c.taskId} className="cal-detail-card">
              <span className="dot" style={{ background: c.categoryColor }} />
              <span className="cal-detail-title">{c.title}</span>
              {name && <span className="cal-detail-cat">{name}</span>}
              <span className={`cal-detail-suffix${c.completed ? "" : " unfinished"} rarity-${s.rarity}`}>
                {s.text}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function HistoryCalendar() {
  const today = localToday();
  const [from, setFrom] = useState(() => mondayOf(addDays(today, -(WEEKS_PER_WINDOW * 7 - 1))));
  const minFrom = oldestMonday(today);
  const atRangeCap = from <= minFrom;

  const activity = useActivity(from, today);
  const categories = useCategories();
  const categoryNames = new Map((categories.data ?? []).map((c) => [c.id, c.name]));
  const days: ActivityDay[] = activity.data?.days ?? [];
  const { columns, summary } = buildCalendar(days, from, today, today);

  // Detail is shown for the pinned (tapped) day, else the hovered/focused one.
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const activeKey = pinnedKey ?? hoverKey;

  const onEnter = useCallback((date: string) => setHoverKey(date), []);
  const onLeave = useCallback(() => setHoverKey(null), []);
  const onToggle = useCallback((date: string, lowerOnly = false) => {
    setPinnedKey((k) => (lowerOnly ? null : k === date ? null : date));
  }, []);

  // Tapping outside a tile lowers the pinned day (skyline's trophy-pile idiom).
  useEffect(() => {
    if (pinnedKey === null) return;
    const lower = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(".cal-cell")) return;
      setPinnedKey(null);
    };
    document.addEventListener("pointerdown", lower);
    return () => document.removeEventListener("pointerdown", lower);
  }, [pinnedKey]);

  const activeCell =
    activeKey == null ? null : columns.flatMap((c) => c.cells).find((c) => c.date === activeKey) ?? null;

  // Open at the most recent weeks; keep them in view when "Load earlier"
  // prepends older columns (mirrors the skyline's scroll-preservation).
  const scrollRef = useRef<HTMLDivElement>(null);
  const initialised = useRef(false);
  const prevWidth = useRef(0);
  const prevFirst = useRef<string | null>(null);
  useEffect(() => {
    if (activity.isError) initialised.current = false;
  }, [activity.isError]);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || columns.length === 0) return;
    const first = columns[0].weekStart;
    if (!initialised.current) {
      el.scrollLeft = el.scrollWidth;
      initialised.current = true;
    } else if (prevFirst.current && first < prevFirst.current) {
      el.scrollLeft += el.scrollWidth - prevWidth.current;
    }
    prevWidth.current = el.scrollWidth;
    prevFirst.current = first;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns.length, columns[0]?.weekStart]);

  const loadEarlier = () =>
    setFrom((f) => {
      const next = addDays(f, -WEEKS_PER_WINDOW * 7);
      return next < minFrom ? minFrom : next;
    });

  return (
    <section className="cal-section">
      <div className="cal-head">
        <h3 style={{ flex: 1 }}>History</h3>
        <button
          onClick={loadEarlier}
          disabled={atRangeCap}
          title={atRangeCap ? "The history view loads at most ten years" : undefined}
        >
          ← Load earlier
        </button>
      </div>

      <p className="cal-summary">
        {summary.activeDays === 0 ? (
          "No activity in this window yet — start a timer or complete a task and this calendar fills in."
        ) : (
          <>
            <strong>{summary.activeDays}</strong> active day{summary.activeDays === 1 ? "" : "s"} ·{" "}
            <strong>{summary.completed}</strong> completed · <strong>{summary.minutes}</strong> min
            tracked{summary.xp > 0 && <> · <strong>{summary.xp}</strong> XP</>}
            <span className="cal-summary-range">
              {formatDay(from)} – today
              {atRangeCap && " · oldest day this view can load"}
            </span>
          </>
        )}
      </p>

      {activity.isError ? (
        <div className="panel" style={{ marginTop: 12 }}>
          <p style={{ color: "var(--text-dim)" }}>
            Couldn't load this history window ({activity.error.message}).{" "}
            <button onClick={() => activity.refetch()}>Retry</button>
          </p>
        </div>
      ) : (
        <div className="cal-scroll" ref={scrollRef}>
          <div className="cal-grid" style={{ gridTemplateColumns: `auto repeat(${columns.length}, var(--cal-cell))` }}>
            {WEEKDAY_LABELS.map((label, row) =>
              label ? (
                <div key={`wd-${row}`} className="cal-weekday" style={{ gridColumn: 1, gridRow: row + 2 }}>
                  {label}
                </div>
              ) : null,
            )}
            {columns.map((column, col) =>
              column.monthLabel ? (
                <div key={`m-${col}`} className="cal-month" style={{ gridColumn: col + 2, gridRow: 1 }}>
                  {column.monthLabel}
                </div>
              ) : null,
            )}
            {columns.map((column, col) =>
              column.cells.map((cell, row) => (
                <Cell
                  key={cell.date ?? `pad-${col}-${row}`}
                  cell={cell}
                  col={col}
                  row={row}
                  active={cell.date != null && cell.date === activeKey}
                  pinned={cell.date != null && cell.date === pinnedKey}
                  onEnter={onEnter}
                  onLeave={onLeave}
                  onToggle={onToggle}
                />
              )),
            )}
          </div>
        </div>
      )}

      <div className="cal-foot">
        <div className="cal-legend" aria-hidden="true">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((n) => (
            <span key={n} className={`cal-swatch lvl-${n}`} />
          ))}
          <span>More</span>
        </div>
        <Detail cell={activeCell} categoryNames={categoryNames} />
      </div>
    </section>
  );
}
