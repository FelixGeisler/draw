import { useGamification } from "../hooks/useGamification";
import { deriveFlame } from "../lib/flameState";

export function GamificationHeader() {
  const { data } = useGamification();
  if (!data) return null;

  const pct = Math.min(100, (data.levelProgress.intoLevel / data.levelProgress.needed) * 100);

  // Four honest flame states (#58): rest and frozen days are never presented
  // as completed. Derivation and precedence live (unit-tested) in
  // lib/flameState.ts.
  const { state: flame, recentFreeze } = deriveFlame(data);

  const flameTitle = {
    lit: "Daily goal met — streak safe!",
    pending: `Complete ${data.dailyGoal} task${data.dailyGoal === 1 ? "" : "s"} to keep the streak`,
    rest: "Rest day — streak safe",
    frozen: `A freeze covered ${recentFreeze} — ${data.freezesBanked}/${data.freezeBankCap} still banked`,
  }[flame];

  const flameFilter = {
    lit: "none",
    pending: "grayscale(1) opacity(0.6)",
    rest: "grayscale(0.6) opacity(0.8)",
    frozen: "grayscale(1) opacity(0.75)",
  }[flame];

  return (
    // Container styles live in index.css (.gami-header) so the phone
    // breakpoint can compact them (#193).
    <div className="gami-header">
      <span style={{ fontWeight: 700 }}>Lv {data.level}</span>
      <div
        title={`${data.levelProgress.intoLevel} / ${data.levelProgress.needed} XP to level ${data.level + 1}`}
        style={{ flex: 1, maxWidth: 260, background: "var(--bg)", borderRadius: 6, height: 10 }}
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
      <span style={{ color: "var(--text-dim)" }}>
        {data.xp} XP · {data.totalGold} Gold
      </span>
      <span style={{ flex: 1 }} />
      <span data-flame={flame} title={flameTitle} style={{ fontSize: 16 }}>
        {flame === "rest" && <span style={{ marginRight: 2 }}>🌙</span>}
        {flame === "frozen" && <span style={{ marginRight: 2 }}>🧊</span>}
        <span style={{ filter: flameFilter }}>🔥 {data.streak}</span>
      </span>
    </div>
  );
}
