import { useGamification } from "../hooks/useGamification";

export function TrophyDeck() {
  const { data } = useGamification();
  const completions = data?.todayCompletions ?? [];
  if (completions.length === 0) return null;

  return (
    <div style={{ marginTop: 32 }}>
      <h3 style={{ color: "var(--text-dim)", fontWeight: 500, fontSize: 14 }}>
        Today's pile — {completions.length} done · {completions.reduce((a, c) => a + c.xpAwarded, 0)} XP
      </h3>
      <div style={{ display: "flex", justifyContent: "center", gap: 0 }}>
        {completions.map((c, i) => (
          <div
            key={c.id}
            title={`${c.title} (+${c.xpAwarded} XP${c.wasDrawn ? ", drawn" : ""})`}
            style={{
              width: 90,
              height: 126,
              borderRadius: 10,
              border: "1px solid var(--border)",
              background: "linear-gradient(160deg, #232735, #1b1e27)",
              padding: 8,
              fontSize: 11,
              overflow: "hidden",
              marginLeft: i === 0 ? 0 : -30,
              transform: `rotate(${(i % 5) * 2 - 4}deg)`,
              boxShadow: "0 3px 12px rgba(0,0,0,0.4)",
            }}
          >
            <div style={{ fontSize: 16 }}>{c.wasDrawn ? "🃏" : "✅"}</div>
            <div
              style={{
                display: "-webkit-box",
                WebkitLineClamp: 4,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {c.title}
            </div>
            <div style={{ color: "var(--ok)", marginTop: 4 }}>+{c.xpAwarded}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
