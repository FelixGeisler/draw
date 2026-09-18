import { useGamification } from "../hooks/useGamification";
import { deriveFlame } from "../lib/flameState";
import { ProjectPicker } from "./ProjectPicker";

export function GamificationHeader() {
  const { data } = useGamification();

  const pct = data
    ? Math.min(100, (data.levelProgress.intoLevel / data.levelProgress.needed) * 100)
    : 0;

  // Four honest flame states (#58): rest and frozen days are never presented
  // as completed. Derivation and precedence live (unit-tested) in
  // lib/flameState.ts.
  const flame = data ? deriveFlame(data) : undefined;
  const flameTitle = data && flame
    ? {
        lit: "Daily goal met — streak safe!",
        pending: `Complete ${data.dailyGoal} task${data.dailyGoal === 1 ? "" : "s"} to keep the streak`,
        rest: "Rest day — streak safe",
        frozen: `A freeze covered ${flame.recentFreeze} — ${data.freezesBanked}/${data.freezeBankCap} still banked`,
      }[flame.state]
    : undefined;

  const flameFilter = flame
    ? {
        lit: "none",
        pending: "grayscale(1) opacity(0.6)",
        rest: "grayscale(0.6) opacity(0.8)",
        frozen: "grayscale(1) opacity(0.75)",
      }[flame.state]
    : undefined;

  return (
    // The project picker lives in this one shared shell header, so route
    // changes neither duplicate nor reset it. The header remains present even
    // while gamification loads because project loading has its own truthful UI.
    <div className="gami-header">
      {data && flame && (
        <>
          <span style={{ fontWeight: 700 }}>Lv {data.level}</span>
          <div
            title={`${data.levelProgress.intoLevel} / ${data.levelProgress.needed} XP to level ${data.level + 1}`}
            style={{ flex: 1, minWidth: 0, maxWidth: 260, background: "var(--bg)", borderRadius: 6, height: 10 }}
          >
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                borderRadius: 6,
                background: "var(--accent-grad)",
                transition: "width 0.5s",
              }}
            />
          </div>
          <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>
            {data.xp} XP · {data.totalGold} Gold
          </span>
          <span style={{ flex: 1 }} />
          <span data-flame={flame.state} title={flameTitle} style={{ fontSize: 16, whiteSpace: "nowrap" }}>
            {flame.state === "rest" && <span style={{ marginRight: 2 }}>🌙</span>}
            {flame.state === "frozen" && <span style={{ marginRight: 2 }}>🧊</span>}
            <span style={{ filter: flameFilter }}>🔥 {data.streak}</span>
          </span>
        </>
      )}
      <ProjectPicker />
    </div>
  );
}
