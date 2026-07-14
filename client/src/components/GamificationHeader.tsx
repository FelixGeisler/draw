import { useGamification } from "../hooks/useGamification";

export function GamificationHeader() {
  const { data } = useGamification();
  if (!data) return null;

  const pct = Math.min(100, (data.levelProgress.intoLevel / data.levelProgress.needed) * 100);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "10px 24px",
        borderBottom: "1px solid var(--border)",
        fontSize: 14,
      }}
    >
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
            background: "linear-gradient(90deg, var(--accent), #a06bff)",
            transition: "width 0.5s",
          }}
        />
      </div>
      <span style={{ color: "var(--text-dim)" }}>{data.xp} XP</span>
      <span style={{ flex: 1 }} />
      <span
        title={
          data.dailyGoalMet
            ? "Daily goal met — streak safe!"
            : `Complete ${data.dailyGoal} task${data.dailyGoal === 1 ? "" : "s"} to keep the streak`
        }
        style={{
          fontSize: 16,
          filter: data.dailyGoalMet ? "none" : "grayscale(1) opacity(0.6)",
        }}
      >
        🔥 {data.streak}
      </span>
    </div>
  );
}
