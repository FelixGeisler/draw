import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type UIEvent,
} from "react";
import { useActivity, type ActivityCard, type ActivityDay } from "../hooks/useActivity";
import { useCategories } from "../hooks/useTasks";
import { addDays, asLocalDate, diffDays, formatDay, localToday } from "../lib/localDay";
import "./HistoryPage.css";

// House-of-cards skyline (#53): one tower per local day, upright cards for
// tasks completed that day, permanent face-down cards for tasks worked on but
// not finished that day. Interaction and a11y reuse the trophy-pile pattern
// (PR #47): CSS-only hover/focus lift, tap toggle with pointerdown-outside
// lowering, transform + z-index only so nothing reflows.

/** Fixed tower slot width — makes the windowed rendering pure arithmetic. */
const DAY_W = 68;
/** Days rendered beyond each viewport edge. */
const OVERSCAN = 7;
/** 8 weeks per fetch window; "Load earlier" extends `from` by another one. */
const WINDOW_DAYS = 56;
/**
 * Mirror of the server's MAX_RANGE_DAYS cap on GET /api/activity (~10 years) —
 * wider requests 400. "Load earlier" clamps to it and disables at the
 * boundary, so the UI never sends a request the server would reject
 * (PR #68 review).
 */
const MAX_RANGE_DAYS = 3653;

/**
 * Card size scales with tracked minutes (fallback: effort estimate for
 * completion-only cards), clamped so one marathon session cannot dwarf its
 * tower and a 1-minute dab still reads as a card.
 */
function cardHeight(card: ActivityCard): number {
  const minutes = card.trackedMinutes > 0 ? card.trackedMinutes : (card.effortMinutes ?? 10);
  return Math.round(Math.max(14, Math.min(44, 12 + minutes * 0.5)));
}

function SkylineCard({
  card,
  date,
  categoryName,
  lifted,
  onToggle,
  onLower,
}: {
  card: ActivityCard;
  date: string;
  categoryName: string | undefined;
  lifted: boolean;
  onToggle: () => void;
  onLower: () => void;
}) {
  const outcome = card.completed
    ? `completed, +${card.xpAwarded} XP${card.wasDrawn ? " (drawn)" : ""}`
    : "not completed this day";
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={lifted}
      aria-label={[
        card.title,
        categoryName,
        formatDay(date),
        `${card.trackedMinutes} min tracked`,
        outcome,
      ]
        .filter(Boolean)
        .join(", ")}
      className={`hoc-card ${card.completed ? "completed" : "face-down"} ${lifted ? "lifted" : ""}`}
      // Data-driven size/color flow in as CSS custom properties — an inline
      // `height`/`transform` would out-specificity the CSS lift states.
      style={
        {
          "--hoc-h": `${cardHeight(card)}px`,
          "--hoc-color": card.categoryColor,
        } as CSSProperties
      }
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        } else if (e.key === "Escape") {
          onLower();
          e.currentTarget.blur(); // drops the :focus-visible lift too
        }
      }}
    >
      <div className="hoc-card-face" />
      <div className="hoc-details">
        <div className="hoc-details-title">{card.title}</div>
        {categoryName && (
          <div>
            <span className="dot" style={{ background: card.categoryColor }} /> {categoryName}
          </div>
        )}
        <div>{formatDay(date)}</div>
        <div>{card.trackedMinutes} min tracked</div>
        {card.completed ? (
          <div className="hoc-details-xp">
            +{card.xpAwarded} XP{card.wasDrawn ? " 🃏" : ""}
          </div>
        ) : (
          <div className="hoc-details-fd">not completed this day</div>
        )}
      </div>
    </div>
  );
}

/** Week/month orientation label under a tower: Mondays and month starts. */
function axisLabel(dateStr: string, today: string): string | null {
  if (dateStr === today) return "today";
  const d = asLocalDate(dateStr);
  if (d.getDate() === 1) {
    // January's tick carries the year — the one orientation point that says
    // which year you have scrolled into.
    return d.toLocaleDateString(
      [],
      d.getMonth() === 0 ? { month: "short", year: "numeric" } : { month: "short" },
    );
  }
  if (d.getDay() === 1) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return null;
}

function Tower({
  day,
  today,
  categoryNames,
  liftedKey,
  setLiftedKey,
}: {
  day: ActivityDay;
  today: string;
  categoryNames: Map<number, string>;
  liftedKey: string | null;
  setLiftedKey: (key: string | null) => void;
}) {
  const label = axisLabel(day.date, today);
  return (
    <div className={`hoc-day ${day.date === today ? "today" : ""}`}>
      <div className="hoc-tower">
        {day.cards.map((card) => {
          const key = `${day.date}|${card.taskId}`;
          return (
            <SkylineCard
              key={card.taskId}
              card={card}
              date={day.date}
              categoryName={categoryNames.get(card.categoryId)}
              lifted={liftedKey === key}
              onToggle={() => setLiftedKey(liftedKey === key ? null : key)}
              onLower={() => setLiftedKey(null)}
            />
          );
        })}
      </div>
      <div
        className={`hoc-axis ${label ? "labelled" : ""}`}
        title={`${formatDay(day.date)} — ${day.totals.completed}/${day.totals.started} done, ${day.totals.minutes} min, ${day.totals.xp} XP`}
      >
        {label ?? "·"}
      </div>
    </div>
  );
}

export function HistoryPage() {
  const today = localToday();
  const [from, setFrom] = useState(() => addDays(today, -(WINDOW_DAYS - 1)));
  // Oldest `from` the server accepts for a window ending today (range cap).
  const minFrom = addDays(today, -(MAX_RANGE_DAYS - 1));
  const atRangeCap = from <= minFrom;
  const activity = useActivity(from, today);
  const categories = useCategories();
  // Tap/click lift (hover and keyboard focus are pure CSS), one card at most.
  const [liftedKey, setLiftedKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ left: 0, width: 0 });

  const days = activity.data?.days ?? [];
  const categoryNames = new Map((categories.data ?? []).map((c) => [c.id, c.name]));
  const totalCards = days.reduce((sum, d) => sum + d.totals.started, 0);

  // Tapping anywhere outside a card lowers the lifted one (trophy-pile
  // pattern) — taps ON a card are excluded; the card's own onClick toggles.
  useEffect(() => {
    if (liftedKey === null) return;
    const lower = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(".hoc-card")) return;
      setLiftedKey(null);
    };
    document.addEventListener("pointerdown", lower);
    return () => document.removeEventListener("pointerdown", lower);
  }, [liftedKey]);

  // The skyline opens at its right end — the most recent towers. Keyed on
  // totalCards too: while the empty-state panel shows, the scroll container
  // isn't mounted, and a refetch can turn empty into non-empty without
  // changing days.length (it stays one window) — the totals transition is
  // what re-runs the effect once the skyline exists (PR #68 review).
  const initialised = useRef(false);

  // An error unmounts the skyline (`days` collapses to []); re-arm the
  // initialisation so recovery lands on the right end again instead of
  // remounting the scroll container at scrollLeft 0.
  useEffect(() => {
    if (activity.isError) initialised.current = false;
  }, [activity.isError]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || days.length === 0 || initialised.current) return;
    el.scrollLeft = el.scrollWidth;
    initialised.current = true;
    setViewport({ left: el.scrollLeft, width: el.clientWidth });
  }, [days.length, totalCards]);

  // "Load earlier" prepends towers: shift scrollLeft so the view keeps
  // showing the same days instead of jumping to the new range start.
  const prevFirst = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || days.length === 0) return;
    const first = days[0].date;
    if (prevFirst.current && first < prevFirst.current) {
      el.scrollLeft += diffDays(first, prevFirst.current) * DAY_W;
      setViewport({ left: el.scrollLeft, width: el.clientWidth });
    }
    prevFirst.current = first;
  }, [days]);

  useEffect(() => {
    const measure = () => {
      const el = scrollRef.current;
      if (el) setViewport({ left: el.scrollLeft, width: el.clientWidth });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setViewport({ left: el.scrollLeft, width: el.clientWidth });
  };

  // Windowed rendering: only towers near the viewport exist in the DOM, so
  // the page stays bounded past ~1000 cards. Fixed DAY_W slots + spacer divs
  // keep scrollWidth (and the scrollbar) honest.
  const startIdx = Math.max(0, Math.floor(viewport.left / DAY_W) - OVERSCAN);
  const endIdx = Math.min(
    days.length,
    Math.ceil((viewport.left + (viewport.width || 1280)) / DAY_W) + OVERSCAN,
  );

  return (
    <div className="content">
      <div className="hoc-header">
        <h1 style={{ flex: 1 }}>History</h1>
        <button
          onClick={() =>
            setFrom((f) => {
              const next = addDays(f, -WINDOW_DAYS);
              return next < minFrom ? minFrom : next;
            })
          }
          disabled={atRangeCap}
          title={atRangeCap ? "The history view loads at most ten years" : undefined}
        >
          ← Load earlier
        </button>
      </div>
      <p className="hoc-legend">
        <span className="hoc-swatch completed" /> completed that day ·{" "}
        <span className="hoc-swatch face-down" /> started but left unfinished — that card stays
        face-down for good ({formatDay(from)} – today)
        {atRangeCap && " · you've reached the oldest day this view can load (ten years back)"}
      </p>

      {activity.isError ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <p style={{ color: "var(--text-dim)" }}>
            Couldn't load this history window ({activity.error.message}).{" "}
            <button onClick={() => activity.refetch()}>Retry</button>
          </p>
        </div>
      ) : activity.data && totalCards === 0 ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <p style={{ color: "var(--text-dim)" }}>
            No activity in this window yet. Start a timer or complete a task and today's tower
            begins — or load earlier history.
          </p>
        </div>
      ) : (
        <div className="hoc-skyline" ref={scrollRef} onScroll={onScroll}>
          {/* Explicit width keeps scrollWidth (and the scrollbar) honest:
              zero-height spacer boxes alone are excluded from Chrome's
              scrollable-overflow computation. */}
          <div className="hoc-strip" style={{ width: days.length * DAY_W }}>
            <div className="hoc-spacer" style={{ width: startIdx * DAY_W }} />
            {days.slice(startIdx, endIdx).map((day) => (
              <Tower
                key={day.date}
                day={day}
                today={today}
                categoryNames={categoryNames}
                liftedKey={liftedKey}
                setLiftedKey={setLiftedKey}
              />
            ))}
            <div className="hoc-spacer" style={{ width: (days.length - endIdx) * DAY_W }} />
          </div>
        </div>
      )}
    </div>
  );
}
