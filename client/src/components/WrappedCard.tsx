import { useMemo, useRef, useState } from "react";
import { useActivity } from "../hooks/useActivity";
import { useGamification } from "../hooks/useGamification";
import { useGoals } from "../hooks/useGoals";
import { useSettings } from "../hooks/useTasks";
import { achievementRarity } from "../lib/achievementRarity";
import { localToday } from "../lib/localDay";
import { wrappedStats, type WrappedStats } from "../lib/wrapped";
import "./WrappedCard.css";

/**
 * Draw Wrapped (#234): "Your year" on Stats — the calendar year folded
 * client-side, rendered to a downloadable PNG in the card idiom. Everything
 * derives from payloads the page already fetches; the PNG is drawn on a
 * local canvas and saved via an <a download> — no data leaves the machine.
 */

const W = 1080;
const H = 1350;

// The palette tokens, inlined: canvas can't read CSS variables from a
// detached context, and Wrapped deliberately ships the app's dark ground
// even if a future theme changes the live tokens.
const INK = { bg: "#12141a", panel: "#1b1e27", text: "#e8eaf0", dim: "#9aa0b0", gold: "#ffb64f" };

function paint(canvas: HTMLCanvasElement, stats: WrappedStats) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  canvas.width = W;
  canvas.height = H;

  ctx.fillStyle = INK.bg;
  ctx.fillRect(0, 0, W, H);
  // The card frame — same rounded ground the trophies use.
  ctx.fillStyle = INK.panel;
  ctx.beginPath();
  ctx.roundRect(60, 60, W - 120, H - 120, 36);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 182, 79, 0.35)";
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = INK.gold;
  ctx.font = "600 44px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`DRAW  ·  ${stats.year} WRAPPED`, W / 2, 170);

  const rows: [string, string][] = [
    [String(stats.cardsCompleted), "cards completed"],
    [String(stats.hoursTracked), "hours of focused work"],
    [String(stats.deepestStreak), "days — deepest streak"],
    [String(stats.xpEarned), "XP earned"],
  ];
  if (stats.holos > 0) rows.push([String(stats.holos), "holo trophies pulled"]);
  if (stats.rarestAchievement) {
    rows.push([stats.rarestAchievement.emoji, `rarest pull: ${stats.rarestAchievement.title}`]);
  }
  if (stats.biggestGoal) {
    rows.push(["🏆", `biggest goal felled: ${stats.biggestGoal.title}`]);
  }

  let y = 330;
  for (const [num, label] of rows) {
    ctx.fillStyle = INK.text;
    ctx.font = "700 96px system-ui, sans-serif";
    ctx.fillText(num, W / 2, y);
    ctx.fillStyle = INK.dim;
    ctx.font = "400 36px system-ui, sans-serif";
    ctx.fillText(label, W / 2, y + 56);
    y += 150;
  }

  ctx.fillStyle = INK.dim;
  ctx.font = "400 28px system-ui, sans-serif";
  ctx.fillText("drawn, not planned", W / 2, H - 110);
}

export function WrappedCard() {
  const today = localToday();
  const year = Number(today.slice(0, 4));
  const activity = useActivity(`${year}-01-01`, today);
  const gamification = useGamification();
  const goals = useGoals("achieved");
  const settings = useSettings();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [open, setOpen] = useState(false);

  const stats = useMemo(() => {
    if (!activity.data || !gamification.data) return null;
    let restWeekdays: number[] = [];
    try {
      const parsed: unknown = JSON.parse(settings.data?.streak_rest_weekdays ?? "[]");
      if (Array.isArray(parsed)) restWeekdays = parsed.filter((d): d is number => Number.isInteger(d));
    } catch {
      // unreadable setting → no rest bridging, never a crash
    }
    return wrappedStats({
      year,
      days: activity.data.days,
      frozenDays: gamification.data.frozenDays,
      restWeekdays,
      achievements: gamification.data.achievements.map((a) => ({
        title: a.title,
        emoji: a.emoji,
        unlockedAt: a.unlockedAt,
        rarity: achievementRarity(a.key),
      })),
      goals: goals.data ?? [],
    });
  }, [activity.data, gamification.data, goals.data, settings.data, year]);

  if (!stats) return null;

  const download = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    paint(canvas, stats);
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `draw-wrapped-${stats.year}.png`;
    a.click();
  };

  return (
    <section className="wrapped panel" data-testid="wrapped">
      <div className="wrapped-heading">Your year</div>
      {!open ? (
        <div className="wrapped-teaser">
          <span className="wrapped-tease-text">
            {stats.year} so far: {stats.cardsCompleted} cards, {stats.hoursTracked}h of focus.
          </span>
          <button type="button" onClick={() => setOpen(true)} data-testid="wrapped-open">
            Unwrap
          </button>
        </div>
      ) : (
        <div className="wrapped-body">
          <ul className="wrapped-list">
            <li>
              <strong>{stats.cardsCompleted}</strong> cards completed
            </li>
            <li>
              <strong>{stats.hoursTracked}</strong> hours of focused work
            </li>
            <li>
              <strong>{stats.deepestStreak}</strong> days — deepest streak
            </li>
            <li>
              <strong>{stats.xpEarned}</strong> XP earned
            </li>
            {stats.holos > 0 && (
              <li>
                <strong>{stats.holos}</strong> holo trophies pulled
              </li>
            )}
            {stats.rarestAchievement && (
              <li>
                rarest pull: {stats.rarestAchievement.emoji}{" "}
                <strong>{stats.rarestAchievement.title}</strong>
              </li>
            )}
            {stats.biggestGoal && (
              <li>
                biggest goal felled: <strong>{stats.biggestGoal.title}</strong> (
                {stats.biggestGoal.doneCount} cards)
              </li>
            )}
          </ul>
          <button type="button" onClick={download} data-testid="wrapped-download">
            Download PNG
          </button>
          {/* Offscreen render target for the PNG — never displayed. */}
          <canvas ref={canvasRef} style={{ display: "none" }} aria-hidden="true" />
        </div>
      )}
    </section>
  );
}
